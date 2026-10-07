import { expect, test } from 'claude-code/testing'

import { REDACTED, projectSlug, redact, renderPage } from './lib'

test('redacts env values and credential-looking keys, keeps the rest', async () => {
  const out = redact({
    model: 'opus',
    env: { ANTHROPIC_API_KEY: 'sk-1', DEBUG: '1' },
    apiKeyHelper: '/bin/get-key',
    mcp: [{ name: 'example', headers: { Authorization: 'Bearer x' } }],
    permissions: { allow: ['Bash(git:*)'] },
  })
  expect(out).toEqual({
    model: 'opus',
    env: { ANTHROPIC_API_KEY: REDACTED, DEBUG: REDACTED },
    apiKeyHelper: REDACTED,
    mcp: [{ name: 'example', headers: { Authorization: REDACTED } }],
    permissions: { allow: ['Bash(git:*)'] },
  })
})

test('slug matches the ~/.claude/projects folder naming', async () => {
  expect(projectSlug('/Users/a.b/Projects/my-app')).toBe('-Users-a-b-Projects-my-app')
})

test('page escapes config so a value cannot close the script tag', async () => {
  const html = renderPage({
    title: 'x <b>',
    exportedAt: 'now',
    session: {},
    sections: [{ id: 'settings', label: 'S', data: { v: '</script><img>' } }],
    downloads: [{ path: 'transcripts/a.jsonl.txt', filename: 'a.jsonl.txt', bytes: 10 }],
    skipped: [],
    viewer: { css: '', js: '' },
  })
  expect(html).toContain('<title>x &lt;b&gt;</title>')
  // every close matches an open: no inlined value ends its script early
  expect(html.match(/<\/script>/g)?.length).toBe(html.match(/<script/g)?.length)
})

test('each transcript gets a download button naming its served path and saved filename', async () => {
  const html = renderPage({
    title: 't',
    exportedAt: 'now',
    session: {},
    sections: [],
    downloads: [
      { path: 'config.json', filename: 'config.json', bytes: 1 },
      { path: 'transcripts/s1/subagents/a.jsonl.txt', filename: 's1__subagents__a.jsonl.txt', bytes: 2 },
    ],
    skipped: ['/big.jsonl'],
    viewer: { css: '', js: 'x </script> y' },
  })
  expect(html).toContain('data-path="transcripts/s1/subagents/a.jsonl.txt" data-filename="s1__subagents__a.jsonl.txt"')
  expect(html).toContain('<span>s1/subagents/a.jsonl</span>')
  expect(html).toContain('<li>/big.jsonl</li>')
  expect(html.match(/<\/script>/g)?.length).toBe(html.match(/<script/g)?.length)
})
