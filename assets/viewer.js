// Transcript viewer for session-export pages, modeled on pi's HTML export:
// outline sidebar with search and filters, stats header, markdown messages,
// collapsible thinking, per-tool renderers. Inlined as a module script; the
// pure part (parseJsonl, buildEntries) is exported for the mod's tests.

const MAX_LINES = 400 // any output is cut here; the download has the rest

export const parseJsonl = text =>
  text.split('\n').flatMap(line => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })

const resultText = content =>
  typeof content === 'string'
    ? content
    : (content ?? []).map(b => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n')

const tag = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

export const buildEntries = records => {
  const entries = []
  const messages = new Map() // assistant message.id -> entry (streamed one block per record)
  const tools = new Map() // tool_use id -> block
  const usage = new Map() // message.id -> final usage
  const stats = { prompts: 0, assistant: 0, tools: 0, errors: 0, models: new Set(), first: null, last: null }
  // Session events: Claude Code re-saves its state every turn, so keep only changes.
  const seen = { mode: undefined, 'permission-mode': undefined, 'ai-title': undefined }
  const tracked = new Set() // files already reported as checkpointed
  const changed = (type, value) => {
    if (value === undefined || seen[type] === value) return false
    seen[type] = value
    return true
  }
  // Hidden text Claude Code adds: a skill's body (linked to its Skill call) and
  // the skill list count as skills; everything else is injected.
  const injected = r => (tools.get(r.sourceToolUseID)?.name === 'Skill' ? { origin: 'skills', label: 'skill' } : { origin: 'injected', label: 'injected' })
  const newlyTracked = paths => {
    const fresh = paths.filter(p => !tracked.has(p))
    fresh.forEach(p => tracked.add(p))
    return fresh.map(p => p.split('/').pop()).join(', ')
  }
  // Slash commands come as `system` local_command records (or user strings in
  // older transcripts): one with the name, a later one with the output.
  const addCommand = (text, base) => {
    const name = tag(text, 'command-name')
    const stdout = tag(text, 'local-command-stdout')
    if (name) {
      entries.push({ ...base, kind: 'command', name, args: tag(text, 'command-args') ?? '', stdout })
      return true
    }
    const open = entries.findLast(e => e.kind === 'command')
    if (stdout === undefined || !open || open.stdout !== undefined) return false
    open.stdout = stdout
    return true
  }

  for (const r of records) {
    if (r.timestamp) {
      stats.first ??= r.timestamp
      stats.last = r.timestamp
    }
    const base = { id: r.uuid ?? `r${entries.length}`, ts: r.timestamp }
    const content = r.message?.content

    if (r.type === 'assistant' && r.message) {
      const msgId = r.message.id ?? base.id
      let entry = messages.get(msgId)
      if (!entry) {
        entry = { ...base, kind: 'assistant', model: r.message.model, blocks: [] }
        messages.set(msgId, entry)
        entries.push(entry)
        stats.assistant++
        if (r.message.model) stats.models.add(r.message.model)
      }
      if (r.message.usage) {
        const u = r.message.usage
        usage.set(msgId, u)
        // Context the model saw for this call: everything sent, cached or not.
        entry.ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      }
      for (const b of content ?? []) {
        if (b.type === 'text' && b.text.trim()) entry.blocks.push({ type: 'text', text: b.text })
        else if (b.type === 'thinking' && b.thinking) entry.blocks.push({ type: 'thinking', text: b.thinking })
        else if (b.type === 'tool_use') {
          const block = { type: 'tool', id: b.id, name: b.name, input: b.input ?? {} }
          tools.set(b.id, block)
          entry.blocks.push(block)
          stats.tools++
        }
      }
      continue
    }

    if (r.type === 'user' && r.message) {
      if (typeof content === 'string') {
        const reminders = content.match(REMINDER) ?? []
        const text = content.replace(REMINDER, '').trim()
        if (addCommand(text, base)) {
          // folded into a command entry
        } else if (r.isMeta) {
          entries.push({ ...base, kind: 'meta', ...injected(r), text })
        } else if (text) {
          entries.push({ ...base, kind: 'user', text, reminders })
          stats.prompts++
        }
        continue
      }
      for (const b of content ?? []) {
        if (b.type === 'tool_result') {
          const block = tools.get(b.tool_use_id)
          const result = { text: resultText(b.content), isError: b.is_error === true }
          if (result.isError) stats.errors++
          if (block) block.result = result
        } else if (b.type === 'text' && b.text.trim()) {
          entries.push({ ...base, kind: r.isMeta ? 'meta' : 'user', ...injected(r), text: b.text, reminders: [] })
          if (!r.isMeta) stats.prompts++
        }
      }
      continue
    }

    if (r.type === 'attachment') {
      const a = r.attachment ?? {}
      const text = a.text ?? a.content ?? JSON.stringify(a, null, 2)
      const origin = String(a.type ?? '').startsWith('skill') ? 'skills' : 'injected'
      entries.push({ ...base, kind: 'meta', origin, label: `attachment · ${a.type ?? '?'}`, text: String(text) })
    } else if (r.type === 'system') {
      if (r.subtype === 'local_command' && addCommand(String(r.content ?? ''), base)) continue
      entries.push({ ...base, kind: 'meta', origin: 'injected', label: `system · ${r.subtype ?? '?'}`, text: r.content ?? '' })
    } else {
      const event = (label, text) => entries.push({ ...base, kind: 'event', label, text })
      if (r.type === 'permission-mode' && changed(r.type, r.permissionMode)) event('Permission mode', r.permissionMode)
      else if (r.type === 'mode' && changed(r.type, r.mode)) event('Mode', r.mode)
      else if (r.type === 'ai-title' && changed(r.type, r.aiTitle)) event('Title', r.aiTitle)
      else if (r.type === 'queue-operation' && r.operation === 'remove') {
        event(r.reason === 'absorbed_mid_turn' ? 'Sent mid-turn' : `Queued message ${r.reason ?? 'removed'}`, String(r.content ?? ''))
      } else if (r.type === 'file-history-snapshot' || r.type === 'file-history-delta') {
        const files = newlyTracked(r.type === 'file-history-delta' ? [r.trackingPath].filter(Boolean) : Object.keys(r.snapshot?.trackedFileBackups ?? {}))
        if (files) event('Files checkpointed', files)
      }
      // Anything else (atis-latch, last-prompt, dev-mods, frame-link, artifact state) is bookkeeping: download only.
    }
  }

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const u of usage.values()) {
    tokens.input += u.input_tokens ?? 0
    tokens.output += u.output_tokens ?? 0
    tokens.cacheRead += u.cache_read_input_tokens ?? 0
    tokens.cacheWrite += u.cache_creation_input_tokens ?? 0
  }
  return { entries, stats: { ...stats, models: [...stats.models], tokens, context: attributeContext(entries) } }
}

// ---- Context attribution ----
// Each API call reports its context size. The growth since the previous call is
// split across what was added in between, by text length (an estimate: the
// transcript has no per-block token counts). The first call's excess over its
// visible content is the system prompt, tool schemas and memory files. When the
// context shrinks (compaction), every origin scales down with it. Thinking is
// left out: the API drops earlier turns' thinking from the context.

export const ORIGINS = ['system', 'you', 'claude', 'tools', 'skills', 'injected']
const zero = () => Object.fromEntries(ORIGINS.map(o => [o, 0]))

const itemsOf = entry => {
  switch (entry.kind) {
    case 'user': return [
      { origin: 'you', chars: entry.text.length, target: entry },
      ...(entry.reminders ?? []).map(r => ({ origin: 'injected', chars: r.length, target: entry })),
    ]
    case 'command': return [{ origin: 'you', chars: `${entry.name} ${entry.args} ${entry.stdout ?? ''}`.length, target: entry }]
    case 'meta': return [{ origin: entry.origin ?? 'injected', chars: String(entry.text).length, target: entry }]
    case 'assistant': return entry.blocks.flatMap(b =>
      b.type === 'text' ? [{ origin: 'claude', chars: b.text.length, target: entry }]
      : b.type === 'tool' ? [{ origin: 'tools', chars: JSON.stringify(b.input).length + (b.result?.text.length ?? 0), target: b }]
      : [])
    default: return []
  }
}

export const attributeContext = entries => {
  let now = zero()
  let prev = 0
  let peak = 0
  let pending = []
  const give = (item, tokens) => {
    now[item.origin] += tokens
    item.target.added ??= {}
    item.target.added[item.origin] = (item.target.added[item.origin] ?? 0) + tokens
  }
  for (const entry of entries) {
    if (entry.kind !== 'assistant' || !entry.ctx) {
      pending.push(...itemsOf(entry))
      continue
    }
    const chars = pending.reduce((n, i) => n + i.chars, 0)
    if (prev === 0) {
      const scale = chars > 0 ? Math.min(0.25, entry.ctx / chars) : 0 // ~4 chars per token
      pending.forEach(i => give(i, i.chars * scale))
      now.system = entry.ctx - chars * scale
    } else if (entry.ctx >= prev) {
      const delta = entry.ctx - prev
      if (chars > 0) pending.forEach(i => give(i, (delta * i.chars) / chars))
      else now.injected += delta
    } else {
      const k = entry.ctx / prev
      for (const o of ORIGINS) now[o] *= k
    }
    entry.contextAt = { ...now }
    peak = Math.max(peak, entry.ctx)
    prev = entry.ctx
    pending = itemsOf(entry) // this reply's output is context for the next call
  }
  // Assumed window: 200k, or 1M once a call went past it.
  return { final: now, total: prev, peak, window: peak > 200_000 ? 1_000_000 : 200_000 }
}

// ---- Rendering (browser only) ----

const el = (name, attrs = {}, ...children) => {
  const node = document.createElement(name)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (k === 'class') node.className = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : String(child))
  }
  return node
}

const compact = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
const time = ts => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
const snippet = (text, n = 90) => {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

const markdown = text => {
  const node = el('div', { class: 'md' })
  if (window.marked && window.DOMPurify) {
    node.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: true }))
    if (window.hljs) node.querySelectorAll('pre code').forEach(c => window.hljs.highlightElement(c))
  } else {
    node.classList.add('plain')
    node.textContent = text
  }
  return node
}

const LANG = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', py: 'python',
  rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', sh: 'bash', zsh: 'bash', json: 'json', md: 'markdown',
  yml: 'yaml', yaml: 'yaml', html: 'xml', xml: 'xml', css: 'css', sql: 'sql' }
const langOf = path => LANG[String(path ?? '').split('.').pop()?.toLowerCase()]

// A pre clamped to `lines` until opened; `O` opens them all.
const output = (text, { lines = 5, lang, error = false } = {}) => {
  const all = String(text ?? '').replace(/\t/g, '   ').split('\n')
  const cut = all.length > MAX_LINES
  const shown = (cut ? all.slice(0, MAX_LINES) : all).join('\n')
  const code = el('code', {}, shown)
  if (lang && window.hljs?.getLanguage(lang)) code.innerHTML = window.hljs.highlight(shown, { language: lang }).value
  const pre = el('pre', { class: `out${error ? ' error' : ''}`, style: `--lines:${lines}` }, code)
  if (cut) pre.append(el('div', { class: 'cut' }, `… ${all.length - MAX_LINES} more lines in the downloaded transcript`))
  if (all.length <= lines) return pre
  pre.classList.add('clamp')
  const more = el('button', { class: 'more', type: 'button' }, `Show all ${all.length} lines`)
  more.addEventListener('click', () => {
    const open = pre.classList.toggle('open')
    more.textContent = open ? 'Collapse' : `Show all ${all.length} lines`
  })
  return el('div', { class: 'out-wrap' }, pre, more)
}

const diff = (oldText, newText) => {
  const rows = [
    ...String(oldText ?? '').split('\n').map(l => el('span', { class: 'del' }, `- ${l}\n`)),
    ...String(newText ?? '').split('\n').map(l => el('span', { class: 'add' }, `+ ${l}\n`)),
  ]
  return el('pre', { class: 'out diff clamp', style: '--lines:14' }, el('code', {}, rows))
}

const TOOL = {
  Bash: i => ({ summary: `$ ${i.command}`, note: i.description, lines: 5 }),
  Read: i => ({ summary: `${i.file_path}${i.offset ? `:${i.offset}` : ''}${i.limit ? `+${i.limit}` : ''}`, lang: langOf(i.file_path), lines: 10 }),
  Edit: i => ({ summary: `${i.file_path}${i.replace_all ? ' (all)' : ''}`, body: diff(i.old_string, i.new_string), quiet: true }),
  MultiEdit: i => ({ summary: `${i.file_path} (${i.edits?.length ?? 0} edits)`, body: el('div', {}, (i.edits ?? []).map(e => diff(e.old_string, e.new_string))), quiet: true }),
  Write: i => ({ summary: `${i.file_path} (${String(i.content ?? '').split('\n').length} lines)`, body: output(i.content, { lines: 10, lang: langOf(i.file_path) }), quiet: true }),
  Grep: i => ({ summary: `/${i.pattern}/ ${i.path ?? ''} ${i.glob ?? ''}`.trim() }),
  Glob: i => ({ summary: `${i.pattern} ${i.path ?? ''}`.trim() }),
  WebFetch: i => ({ summary: i.url, note: i.prompt }),
  WebSearch: i => ({ summary: i.query }),
  Skill: i => ({ summary: `${i.skill}${i.args ? ` ${i.args}` : ''}` }),
  Agent: i => ({ summary: `${i.subagent_type ?? 'agent'}: ${i.description ?? ''}`, body: el('details', { class: 'prompt' }, el('summary', {}, 'Prompt'), markdown(i.prompt ?? '')), lines: 8 }),
  TodoWrite: i => ({ summary: `${i.todos?.length ?? 0} todos`, body: el('ul', { class: 'todos' }, (i.todos ?? []).map(t => el('li', { class: t.status }, t.content))) }),
}

const ORIGIN_LABEL = { system: 'System', you: 'You', claude: 'Claude', tools: 'Tools', skills: 'Skills', injected: 'Injected' }
const ORIGIN_HELP = {
  system: 'Claude Code’s fixed setup, sent with every request: system prompt, tool definitions, CLAUDE.md and memory files. Estimated as the first request’s size minus the first turn’s visible text.',
  you: 'Your prompts, and the output of slash commands you ran.',
  claude: 'Claude’s replies kept in the conversation. Thinking is left out: the API drops earlier turns’ thinking.',
  tools: 'Tool calls Claude made and what they returned: command output, file contents, search and web results.',
  skills: 'The full instructions of each skill that ran, plus the list of available skills Claude can pick from.',
  injected: 'Hidden text Claude Code adds along the way: system reminders, deferred-tool lists, edited-file notices, token budget reminders.',
}
let meterCount = 0
const sumOf = parts => ORIGINS.reduce((n, o) => n + (parts[o] ?? 0), 0)

// Stacked context bar over the window, with a legend carrying every value
// (the light-mode hues sit under 3:1, so labels, not color, carry the reading).
const ctxMeter = window => {
  const segs = Object.fromEntries(ORIGINS.map(o => [o, el('span', { class: `seg seg-${o}` })]))
  const values = Object.fromEntries(ORIGINS.map(o => [o, el('strong', {}, '0')]))
  const caption = el('div', { class: 'ctx-caption' })
  const bar = el('div', { class: 'ctx-bar', role: 'img' }, ORIGINS.map(o => segs[o]))
  const n = ++meterCount
  // Each legend term is focusable and carries its explanation as a tooltip
  // (hover or keyboard focus; a native title would not show on touch or focus).
  const term = o => el('li', {},
    el('span', { class: 'term', tabindex: '0', 'aria-describedby': `tip-${n}-${o}` }, el('i', { class: `sw seg-${o}` }), ORIGIN_LABEL[o], ' ', values[o]),
    el('span', { class: 'tip', role: 'tooltip', id: `tip-${n}-${o}` }, ORIGIN_HELP[o]))
  const node = el('div', { class: 'ctx' }, caption, bar, el('ul', { class: 'ctx-legend' }, ORIGINS.map(term)))
  const set = (parts, label) => {
    const total = sumOf(parts)
    caption.textContent = label
    bar.setAttribute('aria-label', `${label}. ${ORIGINS.map(o => `${ORIGIN_LABEL[o]} ${compact(Math.round(parts[o]))}`).join(', ')}`)
    for (const o of ORIGINS) {
      segs[o].style.width = `${(parts[o] / window) * 100}%`
      segs[o].hidden = parts[o] <= 0
      segs[o].title = `${ORIGIN_LABEL[o]}: ${compact(Math.round(parts[o]))} tokens (${total ? Math.round((parts[o] / total) * 100) : 0}%)`
      values[o].textContent = compact(Math.round(parts[o]))
    }
  }
  return { node, set }
}

// "+1.2k" beside an entry: the context it added, colored by its main origin.
const ctxChip = added => {
  if (!added) return null
  const total = sumOf(added)
  if (total < 1) return null
  const main = ORIGINS.reduce((a, b) => ((added[b] ?? 0) > (added[a] ?? 0) ? b : a))
  const detail = ORIGINS.filter(o => added[o]).map(o => `${ORIGIN_LABEL[o]} ${compact(Math.round(added[o]))}`).join(', ')
  return el('span', { class: 'ctx-chip', title: `Added to context: ${detail} tokens (estimated)` }, el('i', { class: `sw seg-${main}` }), `+${compact(Math.round(total))}`)
}

const toolBlock = block => {
  const spec = (TOOL[block.name] ?? (i => ({ summary: snippet(JSON.stringify(i), 120), body: output(JSON.stringify(i, null, 2), { lines: 3, lang: 'json' }) })))(block.input)
  const status = block.result === undefined ? 'pending' : block.result.isError ? 'error' : 'ok'
  const glyph = { pending: '…', error: '✗', ok: '✓' }[status]
  const node = el('div', { class: `tool ${status}`, id: `t-${block.id}`, 'data-kind': 'tool' },
    el('div', { class: 'tool-head' },
      el('span', { class: 'glyph', title: status }, glyph),
      el('span', { class: 'tool-name' }, block.name),
      el('span', { class: 'tool-summary' }, spec.summary),
      ctxChip(block.added)),
    spec.note ? el('div', { class: 'tool-note' }, spec.note) : null,
    spec.body ?? null)
  // Edit/Write results only echo success; show them only when they failed.
  if (block.result && (!spec.quiet || block.result.isError) && block.result.text.trim()) {
    node.append(output(block.result.text, { lines: spec.lines ?? 5, lang: spec.lang, error: block.result.isError }))
  }
  return node
}

const entryNode = entry => {
  const head = (role, extra) => el('div', { class: 'entry-head' }, el('span', { class: 'role' }, role), extra ?? null, ctxChip(entry.added), el('time', {}, time(entry.ts)))
  const id = `e-${entry.id}`
  switch (entry.kind) {
    case 'user':
      return el('article', { class: 'entry user', id, 'data-kind': 'user' }, head('You'), markdown(entry.text),
        entry.reminders?.length ? el('details', { class: 'meta-inline' }, el('summary', {}, `${entry.reminders.length} system reminder(s)`), output(entry.reminders.join('\n\n'), { lines: 99 })) : null)
    case 'command':
      return el('article', { class: 'entry command', id, 'data-kind': 'user' }, head('Command'),
        el('div', { class: 'cmd' }, `/${entry.name.replace(/^\//, '')} ${entry.args}`.trim()),
        entry.stdout ? output(entry.stdout, { lines: 6 }) : null)
    case 'assistant': {
      const onlyTools = entry.blocks.every(b => b.type === 'tool')
      const noTools = entry.blocks.every(b => b.type !== 'tool')
      // The reply itself is not a filter kind: its text/thinking blocks are
      // `assistant`, its tool blocks `tool`, so the two toggle independently.
      const text = node => { node.dataset.kind = 'assistant'; return node }
      return el('article', { class: `entry assistant${onlyTools ? ' tools-only' : ''}${noTools ? ' no-tools' : ''}`, id, 'data-ctx-at': entry.contextAt ? '' : undefined },
        head('Claude', entry.model ? el('span', { class: 'model' }, entry.model) : null),
        entry.blocks.map(b =>
          b.type === 'text' ? text(markdown(b.text))
          : b.type === 'thinking' ? text(el('details', { class: 'thinking' }, el('summary', {}, 'Thinking'), el('div', { class: 'thinking-text' }, b.text)))
          : toolBlock(b)))
    }
    case 'event':
      return el('article', { class: 'entry event', id, 'data-kind': 'event' },
        el('div', { class: 'event-line' }, el('span', { class: 'role' }, entry.label), el('span', { class: 'event-text' }, entry.text), el('time', {}, time(entry.ts))))
    default:
      return el('article', { class: `entry ${entry.kind}`, id, 'data-kind': entry.kind },
        el('details', {}, el('summary', {}, el('span', { class: 'role' }, entry.label), el('span', { class: 'meta-snip' }, snippet(entry.text, 70)), ctxChip(entry.added), el('time', {}, time(entry.ts))),
          output(entry.text, { lines: 20 })))
  }
}

const navItems = entry => {
  const target = `e-${entry.id}`
  const plain = text => text.replace(/[`*_#>]+/g, '') // outline rows show text, not markdown
  const item = (kind, glyph, text, to = target) => el('button', { class: `nav nav-${kind}`, type: 'button', 'data-kind': kind, 'data-to': to, 'data-search': text.toLowerCase() }, el('span', { class: 'nav-glyph' }, glyph), el('span', { class: 'nav-text' }, snippet(plain(text), 120)))
  switch (entry.kind) {
    case 'user': return [item('user', '›', entry.text.replace(/<\/?[a-z_-]+[^>]*>/gi, ' '))]
    case 'command': return [item('user', '/', `${entry.name} ${entry.args}`)]
    case 'assistant': return entry.blocks.flatMap(b =>
      b.type === 'text' ? [item('assistant', '◆', b.text)]
      : b.type === 'tool' ? [item('tool', b.result?.isError ? '✗' : '⚙', `${b.name} ${b.input.description ?? (b.input.file_path ? String(b.input.file_path).split('/').pop() : TOOL[b.name]?.(b.input).summary ?? '')}`, `t-${b.id}`)]
      : [])
    case 'event': return [item('event', '◇', `${entry.label}: ${entry.text}`)]
    default: return [item(entry.kind, '·', `${entry.label} ${entry.text}`)]
  }
}

// Toggle chips, combinable; the hidden set survives switching transcripts.
const KINDS = [['user', 'You'], ['assistant', 'Claude'], ['tool', 'Tools'], ['event', 'Session events'], ['meta', 'Injected']]
const hidden = new Set(['meta'])
let onScroll = () => {}
let syncFrame = 0

const render = (root, transcripts, current, { entries, stats }) => {
  const minutes = stats.first && stats.last ? Math.round((new Date(stats.last) - new Date(stats.first)) / 60000) : 0
  const flash = node => {
    const behavior = matchMedia('(prefers-reduced-motion: no-preference)').matches ? 'smooth' : 'auto'
    node.scrollIntoView({ behavior, block: 'center' })
    node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash')
  }
  const search = el('input', { id: 'tx-search', type: 'search', placeholder: 'Search the outline', 'aria-label': 'Search the outline' })
  const nav = el('nav', { class: 'outline', 'aria-label': 'Transcript outline' }, entries.flatMap(navItems))
  const messages = el('div', { class: 'messages' }, entries.map(entryNode))
  const counts = Object.fromEntries(KINDS.map(([k]) => [k, nav.querySelectorAll(`[data-kind="${k}"]`).length]))
  const applyFilters = () => {
    root.dataset.hide = [...hidden].join(' ')
    root.querySelectorAll('.filter').forEach(b => b.setAttribute('aria-pressed', String(!hidden.has(b.dataset.kind))))
  }
  const toggle = kind => {
    if (!hidden.delete(kind)) hidden.add(kind)
    applyFilters()
    onScroll() // the reply under the fold may have changed
  }
  const { context } = stats
  const sideMeter = ctxMeter(context.window)
  const headMeter = ctxMeter(context.window)
  headMeter.set(context.final, `Context at the end: ${compact(context.total)} of ${compact(context.window)} window (assumed) · peak ${compact(context.peak)}`)
  const picker = transcripts.length > 1
    ? el('select', { id: 'tx-file', 'aria-label': 'Transcript file', onchange: e => load(root, transcripts, e.target.value) },
        transcripts.map(t => el('option', { value: t.path, selected: t.path === current }, t.label)))
    : null

  root.replaceChildren(
    el('aside', { class: 'side' },
      picker,
      sideMeter.node,
      search,
      el('div', { class: 'filters', role: 'group', 'aria-label': 'Show' }, KINDS.map(([kind, label]) =>
        el('button', { class: 'filter', type: 'button', 'data-kind': kind, onclick: () => toggle(kind) }, label, el('span', { class: 'count' }, counts[kind])))),
      nav,
      el('p', { class: 'keys' }, el('kbd', {}, 'T'), ' thinking · ', el('kbd', {}, 'O'), ' outputs · ', el('kbd', {}, 'Esc'), ' clear')),
    el('div', { class: 'main' }, messages))
  applyFilters()
  document.getElementById('context')?.replaceChildren(headMeter.node)
  // The sidebar meter follows the reply nearest above the middle of the screen.
  const marks = [...messages.querySelectorAll('[data-ctx-at]')]
  const byId = new Map(entries.filter(e => e.contextAt).map(e => [`e-${e.id}`, e]))
  const sync = () => {
    syncFrame = 0
    const mid = innerHeight / 2
    let current
    for (const m of marks) {
      if (!m.offsetParent) continue // filtered out
      if (m.getBoundingClientRect().top > mid) break
      current = byId.get(m.id)
    }
    sideMeter.set(current?.contextAt ?? zero(), current ? `At ${time(current.ts)}: ${compact(current.ctx)} of ${compact(context.window)}` : 'Before the first reply')
  }
  removeEventListener('scroll', onScroll)
  onScroll = () => { syncFrame ||= requestAnimationFrame(sync) }
  addEventListener('scroll', onScroll, { passive: true })
  sync()
  // Stats live in the page header, the same on every tab.
  document.getElementById('stats')?.replaceChildren(
    ...[['Prompts', stats.prompts], ['Replies', stats.assistant], ['Tool calls', stats.tools], ['Tool errors', stats.errors],
      ['Tokens ↑ / ↓', `${compact(stats.tokens.input)} / ${compact(stats.tokens.output)}`],
      ['Cache R / W', `${compact(stats.tokens.cacheRead)} / ${compact(stats.tokens.cacheWrite)}`],
      ['Duration', `${minutes} min`], ['Models', stats.models.join(', ') || '—']]
      .map(([k, v]) => el('div', { class: `stat${k === 'Tool errors' && v > 0 ? ' bad' : ''}` }, el('span', {}, k), el('strong', {}, v))))

  nav.addEventListener('click', e => {
    const to = e.target.closest('.nav')?.dataset.to
    const node = to && document.getElementById(to)
    if (node) flash(node)
  })
  search.addEventListener('input', () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean)
    nav.querySelectorAll('.nav').forEach(n => { n.hidden = !words.every(w => n.dataset.search.includes(w)) })
  })
  const target = location.hash.length > 1 && document.getElementById(location.hash.slice(1))
  if (target) flash(target)
}

const load = async (root, transcripts, path) => {
  root.replaceChildren(el('p', { class: 'loading' }, 'Loading transcript…'))
  try {
    const res = await fetch(path)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    render(root, transcripts, path, buildEntries(parseJsonl(await res.text())))
  } catch (err) {
    root.replaceChildren(el('p', { class: 'loading' }, `Could not load ${path}: ${err.message}. The Downloads tab still has the file.`))
  }
}

const boot = () => {
  const root = document.getElementById('viewer')
  const transcripts = JSON.parse(document.getElementById('transcripts').textContent)
  if (!root || transcripts.length === 0) return
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return
    const key = e.key.toLowerCase()
    if (key === 't') {
      const open = !root.classList.toggle('thinking-closed')
      root.querySelectorAll('details.thinking').forEach(d => { d.open = open })
    } else if (key === 'o') {
      root.classList.toggle('outputs-open')
    } else if (e.key === 'Escape') {
      const search = document.getElementById('tx-search')
      if (search) { search.value = ''; search.dispatchEvent(new Event('input')) }
    }
  })
  root.classList.add('thinking-closed')
  load(root, transcripts, transcripts[0].path)
}

if (typeof document !== 'undefined') boot()
