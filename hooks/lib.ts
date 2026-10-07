// Pure parts of the export: no `$`, so tests run them directly.

export const REDACTED = '‹redacted›'

// Keys whose values may hold credentials. `env` values are dropped wholesale:
// settings env blocks routinely carry tokens under innocuous names.
const SECRET_KEY = /token|secret|passw|api[_-]?key|auth|credential|cookie|private|helper/i

export const redact = (value: unknown, key = ''): unknown => {
  if (key === 'env' && value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map(name => [name, REDACTED]))
  }
  if (key !== '' && SECRET_KEY.test(key) && typeof value !== 'object') return REDACTED
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  }
  return value
}

// How Claude Code names a project's folder under ~/.claude/projects.
export const projectSlug = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-')

// A file published next to the page (`path`) that the viewer saves as
// `filename`: .jsonl is served and saved as .txt, the closest allowed type.
export type Download = { path: string; filename: string; bytes: number }

export type Export = {
  title: string
  exportedAt: string
  session: Record<string, unknown>
  sections: { id: string; label: string; data: unknown }[]
  downloads: Download[]
  skipped: string[]
  // assets/viewer.{css,js}, inlined so the page is one document.
  viewer: { css: string; js: string }
}

// Transcripts the viewer can open, main session first.
export const transcriptsOf = (downloads: Download[]) =>
  downloads
    .filter(d => d.path.startsWith('transcripts/'))
    .map((d, i) => ({ path: d.path, label: i === 0 ? 'Main session' : d.path.slice('transcripts/'.length).replace(/\.jsonl\.txt$/, '') }))

// Inline text must not close its own element.
const inline = (text: string, element: 'script' | 'style') => text.replace(new RegExp(`</${element}`, 'gi'), `<\\/${element}`)
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const kb = (bytes: number) =>
  bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const CDN = 'https://cdnjs.cloudflare.com/ajax/libs'

export const renderPage = (x: Export) => `<title>${escape(x.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<style>
/* Layout: a recorder plate (identity) over tabs: transcript (outline + messages), configuration, downloads */
:root {
  --bg: #f4f6f8; --panel: #ffffff; --fg: #1b2129; --muted: #5d6875; --line: #d9dee4;
  --accent: #d9480f; --accent-fg: #ffffff; --code: #eef1f4;
  --good: #2b7a3d; --good-bg: #e3f3e6; --bad: #c0262d; --bad-bg: #fbe5e6;
  --hl-key: #8a3ffc; --hl-str: #2b7a3d; --hl-num: #b25d00; --hl-title: #0f62fe;
  /* context origins: categorical slots 1-6, fixed order, validated for CVD in both themes */
  --c-system: #2a78d6; --c-you: #eb6834; --c-claude: #1baf7a; --c-tools: #eda100; --c-skills: #e87ba4; --c-injected: #008300;
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #11151a; --panel: #181d24; --fg: #e3e8ee; --muted: #94a0ad; --line: #2a323c;
  --accent: #ff7a3d; --accent-fg: #1a0d05; --code: #1e242c;
  --good: #6fcf86; --good-bg: #16291c; --bad: #ff7b80; --bad-bg: #331a1c;
  --hl-key: #c4a3ff; --hl-str: #8fd99f; --hl-num: #ffb366; --hl-title: #78a9ff;
  --c-system: #3987e5; --c-you: #d95926; --c-claude: #199e70; --c-tools: #c98500; --c-skills: #d55181; --c-injected: #008300; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #11151a; --panel: #181d24; --fg: #e3e8ee; --muted: #94a0ad; --line: #2a323c;
  --accent: #ff7a3d; --accent-fg: #1a0d05; --code: #1e242c;
  --good: #6fcf86; --good-bg: #16291c; --bad: #ff7b80; --bad-bg: #331a1c;
  --hl-key: #c4a3ff; --hl-str: #8fd99f; --hl-num: #ffb366; --hl-title: #78a9ff;
  --c-system: #3987e5; --c-you: #d95926; --c-claude: #199e70; --c-tools: #c98500; --c-skills: #d55181; --c-injected: #008300; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font: 15px/1.55 var(--sans); }
/* minmax(0, 1fr): wide config JSON must scroll in its pre, not widen the page and its header */
.page { max-width: 84rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.25rem; }
.plate { background: var(--panel); border: 1px solid var(--line); border-top: 4px solid var(--accent);
  border-radius: 6px; padding: 1.1rem 1.25rem; display: grid; gap: 0.8rem; }
.eyebrow { font: 500 0.72rem/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
h1 { font-size: 1.5rem; font-weight: 600; margin: 0; text-wrap: balance; overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.6rem 1.5rem; margin: 0; }
dl div { min-width: 0; }
dt { font-size: 0.72rem; color: var(--muted); letter-spacing: 0.04em; text-transform: uppercase; }
dd { margin: 0; font: 0.85rem/1.4 var(--mono); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
button { font: 500 0.88rem var(--sans); border-radius: 5px; padding: 0.5rem 0.95rem; cursor: pointer;
  border: 1px solid var(--line); background: var(--panel); color: var(--fg); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tabs { display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; border-bottom: 1px solid var(--line); }
.tab { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--muted); padding: 0.55rem 0.8rem; margin-bottom: -1px; }
.tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
#status { margin-left: auto; font-size: 0.82rem; color: var(--muted); }
.note { font-size: 0.85rem; color: var(--muted); margin: 0; max-width: 65ch; }
code { font: 0.85em var(--mono); }
.config { display: grid; gap: 0.75rem; }
.config details { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.config summary { cursor: pointer; padding: 0.75rem 1rem; font-weight: 500; display: flex; justify-content: space-between; gap: 1rem; }
.config summary span { font: 0.78rem var(--mono); color: var(--muted); }
.config pre { margin: 0; padding: 1rem; background: var(--code); border-top: 1px solid var(--line);
  font: 0.8rem/1.5 var(--mono); overflow-x: auto; max-height: 32rem; }
.config > button { justify-self: start; }
.files-tab { display: grid; gap: 1rem; max-width: 60rem; }
.downloads { list-style: none; margin: 0; padding: 0; display: grid; border-top: 1px solid var(--line); }
.downloads li { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.6rem 0; border-bottom: 1px solid var(--line); }
.downloads li span:first-child { flex: 1 1 16rem; min-width: 0; font: 0.82rem var(--mono); overflow-wrap: anywhere; }
.downloads .size { font: 0.8rem var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.files { font: 0.8rem/1.6 var(--mono); color: var(--muted); margin: 0; padding-left: 1.2rem; overflow-wrap: anywhere; }
${inline(x.viewer.css, 'style')}
</style>
<div class="page">
  <header class="plate">
    <div class="eyebrow">Claude Code session export · ${escape(x.exportedAt)}</div>
    <h1>${escape(x.title)}</h1>
    <dl>${Object.entries(x.session)
      .map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(String(v ?? '—'))}</dd></div>`)
      .join('')}</dl>
    <div class="stats" id="stats" aria-label="Transcript stats"></div>
    <div id="context"></div>
  </header>
  <div class="tabs" role="tablist">
    <button class="tab" role="tab" type="button" id="tab-transcript" aria-controls="panel-transcript">Transcript</button>
    <button class="tab" role="tab" type="button" id="tab-config" aria-controls="panel-config">Configuration</button>
    <button class="tab" role="tab" type="button" id="tab-downloads" aria-controls="panel-downloads">Downloads</button>
    <span id="status" role="status"></span>
  </div>
  <section id="panel-transcript" role="tabpanel" aria-labelledby="tab-transcript">
    <div id="viewer"><p class="loading">Loading transcript…</p></div>
  </section>
  <section id="panel-config" role="tabpanel" aria-labelledby="tab-config" class="config" hidden>
    <button id="copy" type="button">Copy config JSON</button>
    ${x.sections
      .map(
        s => `<details${s.id === 'settings' ? ' open' : ''}><summary>${escape(s.label)}<span>${escape(s.id)}</span></summary><pre>${escape(JSON.stringify(s.data, null, 2))}</pre></details>`,
      )
      .join('\n    ')}
  </section>
  <section id="panel-downloads" role="tabpanel" aria-labelledby="tab-downloads" class="files-tab" hidden>
    <ul class="downloads">${x.downloads
      .map(
        (d, i) =>
          `<li><span>${escape(d.path.replace(/^transcripts\//, '').replace(/\.txt$/, ''))}</span><span class="size">${kb(d.bytes)}</span><button${i === 1 ? ' class="primary"' : ''} type="button" data-path="${escape(d.path)}" data-filename="${escape(d.filename)}">Download</button></li>`,
      )
      .join('')}</ul>
    <p class="note">Transcripts are the raw JSONL: every message, tool call and result, subagents included. They save as <code>.jsonl.txt</code>; drop the <code>.txt</code> to get the original file. They can contain secrets that tools read during the session, so check before sharing this page beyond your team. Settings values that look like credentials are redacted on this page and in config.json.</p>
    ${x.skipped.length > 0 ? `<p class="note">Too large to attach (kept on the exporting machine):</p><ul class="files">${x.skipped.map(f => `<li>${escape(f)}</li>`).join('')}</ul>` : ''}
  </section>
</div>
<script type="application/json" id="config">${json(Object.fromEntries(x.sections.map(s => [s.id, s.data])))}</script>
<script type="application/json" id="transcripts">${json(transcriptsOf(x.downloads))}</script>
<script src="${CDN}/marked/12.0.2/marked.min.js"></script>
<script src="${CDN}/dompurify/3.1.6/purify.min.js"></script>
<script src="${CDN}/highlight.js/11.9.0/highlight.min.js"></script>
<script>
const status = document.getElementById('status')
const say = text => { status.textContent = text }
const TABS = ['transcript', 'config', 'downloads']
const show = name => TABS.forEach(t => {
  document.getElementById('tab-' + t).setAttribute('aria-selected', String(t === name))
  document.getElementById('panel-' + t).hidden = t !== name
})
TABS.forEach(t => document.getElementById('tab-' + t).addEventListener('click', () => show(t)))
show(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'transcript')
document.querySelectorAll('button[data-path]').forEach(button => button.addEventListener('click', async () => {
  const downloads = await window.claude?.use?.('downloads')
  if (!downloads) return say('Downloads are not available in this view.')
  const { path, filename } = button.dataset
  try {
    say('Fetching ' + filename + '…')
    const res = await fetch(path)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    await downloads.save({ filename, data: await res.blob() })
    say('Saved ' + filename + '.')
  } catch (err) {
    say(err?.code === 'declined' ? 'Download cancelled.' : 'Download failed: ' + (err?.message ?? err))
  }
}))
document.getElementById('copy').addEventListener('click', async () => {
  const text = JSON.stringify(JSON.parse(document.getElementById('config').textContent), null, 2)
  try { await navigator.clipboard.writeText(text); say('Config copied.') }
  catch { say('Copy refused by this view: open a section and select its text.') }
})
</script>
<script type="module">
${inline(x.viewer.js, 'script')}
</script>
`
