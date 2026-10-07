import { expect, test } from 'claude-code/testing'

import { buildEntries, parseJsonl } from '../assets/viewer.js'

const line = (r: object) => JSON.stringify(r)
const usage = (output: number) => ({ input_tokens: 2, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 })

test('streamed assistant records merge into one reply and tool results attach to their call', async () => {
  const jsonl = [
    line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'list files' } }),
    line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'hmm' }], usage: usage(5) } }),
    line({ type: 'assistant', uuid: 'a2', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage: usage(9) } }),
    'not json',
    line({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'denied', is_error: true }] } }),
  ].join('\n')
  const { entries, stats } = buildEntries(parseJsonl(jsonl))

  expect(entries.map(e => e.kind)).toEqual(['user', 'assistant'])
  expect(entries[1]!.blocks).toEqual([
    { type: 'thinking', text: 'hmm' },
    { type: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' }, result: { text: 'denied', isError: true } },
  ])
  expect(stats).toMatchObject({ prompts: 1, assistant: 1, tools: 1, errors: 1, models: ['claude-opus-5-5'] })
  // usage counted once per message, from its last record
  expect(stats.tokens).toEqual({ input: 2, output: 9, cacheRead: 100, cacheWrite: 10 })
})

test('slash command and its output become one entry; reminders and meta stay out of prompts', async () => {
  const jsonl = [
    line({ type: 'user', uuid: 'c1', message: { content: '<command-name>/export-session</command-name><command-args></command-args>' } }),
    line({ type: 'user', uuid: 'c2', message: { content: '<local-command-stdout>published</local-command-stdout>' } }),
    line({ type: 'user', uuid: 'u1', message: { content: 'hi<system-reminder>secret context</system-reminder>' } }),
    line({ type: 'user', uuid: 'm1', isMeta: true, message: { content: 'injected' } }),
    line({ type: 'mode', mode: 'auto' }),
  ].join('\n')
  const { entries, stats } = buildEntries(parseJsonl(jsonl))

  expect(entries.map(e => e.kind)).toEqual(['command', 'user', 'meta', 'event'])
  expect(entries[0]).toMatchObject({ name: '/export-session', stdout: 'published' })
  expect(entries[1]).toMatchObject({ text: 'hi', reminders: ['<system-reminder>secret context</system-reminder>'] })
  expect(stats.prompts).toBe(1)
})

test('system local_command records become a command entry with its output, even with records between', async () => {
  const jsonl = [
    line({ type: 'system', subtype: 'local_command', uuid: 's1', content: '<command-name>/export-session</command-name>\n<command-args>x</command-args>' }),
    line({ type: 'attachment', uuid: 'a1', attachment: { type: 'total_tokens_reminder', text: 'left' } }),
    line({ type: 'system', subtype: 'local_command', uuid: 's2', content: '<local-command-stdout>published: url</local-command-stdout>' }),
  ].join('\n')
  const { entries } = buildEntries(parseJsonl(jsonl))

  expect(entries.map(e => e.kind)).toEqual(['command', 'meta'])
  expect(entries[0]).toMatchObject({ name: '/export-session', args: 'x', stdout: 'published: url' })
})

test('session events keep only changes and drop bookkeeping records', async () => {
  const jsonl = [
    line({ type: 'permission-mode', permissionMode: 'auto' }),
    line({ type: 'permission-mode', permissionMode: 'auto' }),
    line({ type: 'ai-title', aiTitle: 'Export' }),
    line({ type: 'last-prompt', lastPrompt: 'x' }),
    line({ type: 'atis-latch', atis: '' }),
    line({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { '/r/a.ts': {} } } }),
    line({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { '/r/a.ts': {}, '/r/b.ts': {} } } }),
    line({ type: 'queue-operation', operation: 'enqueue', content: 'hey' }),
    line({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', content: 'hey' }),
    line({ type: 'permission-mode', permissionMode: 'default' }),
  ].join('\n')
  const { entries } = buildEntries(parseJsonl(jsonl))

  expect(entries.map(e => [e.label, e.text])).toEqual([
    ['Permission mode', 'auto'],
    ['Title', 'Export'],
    ['Files checkpointed', 'a.ts'],
    ['Files checkpointed', 'b.ts'],
    ['Sent mid-turn', 'hey'],
    ['Permission mode', 'default'],
  ])
})

test('context growth between calls is split by origin and sums to each call’s context', async () => {
  const jsonl = [
    line({ type: 'user', uuid: 'u1', message: { content: 'x'.repeat(400) } }), // ~100 tokens at 4 chars/token
    line({ type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: 'y'.repeat(300) }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }], usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }),
    line({ type: 'user', uuid: 'r1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'z'.repeat(698) }] } }),
    line({ type: 'assistant', uuid: 'a2', message: { id: 'm2', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 990, output_tokens: 1 } } }),
    line({ type: 'assistant', uuid: 'a3', message: { id: 'm3', content: [{ type: 'text', text: 'after compaction' }], usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } }),
  ].join('\n')
  const { entries, stats } = buildEntries(parseJsonl(jsonl))
  const [user, a1, a2, a3] = entries
  const sum = (p: Record<string, number>) => Object.values(p).reduce((n, v) => n + v, 0)

  expect(user!.added).toEqual({ you: 100 })
  expect(a1!.contextAt).toEqual({ system: 900, you: 100, claude: 0, tools: 0, skills: 0, injected: 0 })
  // 1000 tokens added before call 2: Claude's 300-char reply vs the 700-char tool call + result
  expect(a1!.added).toEqual({ claude: 300 })
  expect(a1!.blocks[1].added).toEqual({ tools: 700 })
  expect(sum(a2!.contextAt)).toBe(2000)
  // context shrank to 1000: every origin halves
  expect(a3!.contextAt).toEqual({ system: 450, you: 50, claude: 150, tools: 350, skills: 0, injected: 0 })
  expect(stats.context).toMatchObject({ total: 1000, peak: 2000, window: 200_000 })
})

test('skill bodies and the skill list count as skills; other hidden text as injected', async () => {
  const jsonl = [
    line({ type: 'assistant', uuid: 'a0', message: { id: 'm0', content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'tdd' } }] } }),
    line({ type: 'user', uuid: 'k1', isMeta: true, sourceToolUseID: 's1', message: { content: [{ type: 'text', text: 'Base directory for this skill: …' }] } }),
    line({ type: 'attachment', uuid: 'l1', attachment: { type: 'skill_listing', content: 'tdd, grilling' } }),
    line({ type: 'attachment', uuid: 'r1', attachment: { type: 'total_tokens_reminder', text: '15M left' } }),
    line({ type: 'user', uuid: 'u1', message: { content: 'go<system-reminder>CLAUDE.md</system-reminder>' } }),
  ].join('\n')
  const { entries } = buildEntries(parseJsonl(jsonl))
  const metas = entries.filter(e => e.kind === 'meta')

  expect(metas.map(e => [e.label, e.origin])).toEqual([
    ['skill', 'skills'],
    ['attachment · skill_listing', 'skills'],
    ['attachment · total_tokens_reminder', 'injected'],
  ])
})
