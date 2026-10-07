import type { EngineInterface, Register } from 'claude-code'

import { type Download, projectSlug, redact, renderPage } from './lib'

const COMMAND = 'export-session'
// The Artifact tool's limits: 16 MB per text file, 64 MB per publish.
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_PUBLISH_BYTES = 60 * 1024 * 1024

type $ = EngineInterface

// The transcript lives at <config>/projects/<slug>/<id>.jsonl; the slug is
// derived from the start directory, so try it first, then scan every project.
const findProjectDir = async ($: $, projects: string, id: string, dirs: string[]) => {
  for (const dir of dirs) {
    const candidate = `${projects}/${projectSlug(dir)}`
    if (await $.fs.exists(`${candidate}/${id}.jsonl`)) return candidate
  }
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind !== 'dir') continue
    if (await $.fs.exists(`${projects}/${entry.name}/${id}.jsonl`)) return `${projects}/${entry.name}`
  }
  return undefined
}

// The Artifact tool only publishes files under the working directory or the
// session scratchpad (<tmp>/claude-<uid>/<slug>/<id>/scratchpad). Prefer the
// scratchpad so nothing lands in the repo.
const findStagingDir = async ($: $, slug: string, id: string, cwd: string) => {
  for (const base of ['/private/tmp', '/tmp']) {
    const entries = await $.fs.list(base).catch(() => [])
    for (const entry of entries) {
      if (!entry.name.startsWith('claude-')) continue
      const scratch = `${base}/${entry.name}/${slug}/${id}/scratchpad`
      if (await $.fs.exists(scratch)) return `${scratch}/session-export`
    }
  }
  return `${cwd}/.claude/session-exports/${id}`
}

const run = async ($: $, argv: string[], cwd?: string) => {
  const done = await $.process.run(argv, { cwd, timeoutMs: 120_000 })
  if (done.exitCode !== 0) throw new Error(`${argv[0]} failed: ${done.stderr.trim() || done.exitCode}`)
  return done.stdout
}

const exportSession = async ($: $) => {
  const [id, cwd, root, version, repo, surfaces] = await Promise.all([
    $.session.id(),
    $.session.cwd(),
    $.session.root(),
    $.session.version(),
    $.session.repo(),
    $.session.surfaces(),
  ])
  const home = (await $.env.get('HOME')) ?? ''
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`

  const projectDir = await findProjectDir($, `${configDir}/projects`, id, [root, cwd])
  if (projectDir === undefined) return `No transcript found for session ${id} under ${configDir}/projects.`
  const slug = projectDir.slice(projectDir.lastIndexOf('/') + 1)
  const staging = await findStagingDir($, slug, id, cwd)

  const sources = ['user', 'project', 'local', 'flag', 'policy'] as const
  const bySource = await Promise.all(sources.map(source => $.settings.read({ source })))
  const memory = await $.fs.ancestors({ names: ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'] })
  const sections = [
    { id: 'settings', label: 'Effective settings (merged)', data: redact(await $.settings.read()) },
    {
      id: 'settingsBySource',
      label: 'Settings by source',
      data: redact(Object.fromEntries(sources.map((s, i) => [s, bySource[i]]))),
    },
    { id: 'tools', label: 'Tools available to the model', data: (await $.tool.list()).map(t => t.name) },
    {
      id: 'commands',
      label: 'Slash commands',
      data: (await $.command.list()).map(c => `/${c.name}  (${c.source})`),
    },
    {
      id: 'memory',
      label: 'Instruction files loaded from the project tree',
      data: memory.map(m => ({ path: `${m.dir}/${m.name}`, chars: m.content.length })),
    },
  ]
  const session = {
    'Session id': id,
    'Claude Code': version.version,
    'Working dir': cwd,
    Repository: repo?.remote ?? repo?.root ?? null,
    Surfaces: surfaces.join(', '),
  }

  await $.fs.write(
    `${staging}/config.json`,
    JSON.stringify({ session, ...Object.fromEntries(sections.map(s => [s.id, s.data])) }, null, 2),
  )

  // Main transcript plus subagent ones under <id>/, paths relative to the
  // project folder. Artifacts serve no .jsonl, so each goes up as a .txt copy.
  const subagents = (await $.fs.exists(`${projectDir}/${id}`))
    ? (await run($, ['find', id, '-name', '*.jsonl'], projectDir)).trim().split('\n').filter(Boolean)
    : []
  await run($, ['rm', '-rf', `${staging}/transcripts`])
  const files: Record<string, { from: string; contentType: string }> = {
    'config.json': { from: `${staging}/config.json`, contentType: 'application/json' },
  }
  const downloads: Download[] = [{ path: 'config.json', filename: 'config.json', bytes: 0 }]
  const skipped: string[] = []
  let total = 0
  for (const rel of [`${id}.jsonl`, ...subagents.sort()]) {
    const bytes = (await $.fs.stat(`${projectDir}/${rel}`)).size
    if (bytes > MAX_FILE_BYTES || total + bytes > MAX_PUBLISH_BYTES) {
      skipped.push(`${projectDir}/${rel}`)
      continue
    }
    total += bytes
    const published = `transcripts/${rel}.txt`
    await run($, ['mkdir', '-p', `${staging}/${published.slice(0, published.lastIndexOf('/'))}`])
    await run($, ['cp', `${projectDir}/${rel}`, `${staging}/${published}`])
    files[published] = { from: `${staging}/${published}`, contentType: 'text/plain' }
    downloads.push({ path: published, filename: `${rel.replace(/\//g, '__')}.txt`, bytes })
  }
  downloads[0] = { ...downloads[0]!, bytes: (await $.fs.stat(`${staging}/config.json`)).size }

  const title = `${root.slice(root.lastIndexOf('/') + 1)} session ${id.slice(0, 8)}`
  const pagePath = `${staging}/index.html`
  await $.fs.write(
    pagePath,
    renderPage({
      title,
      exportedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      session,
      sections,
      downloads,
      skipped,
      viewer: {
        css: await $.fs.read(`${$.plugin.root}/assets/viewer.css`),
        js: await $.fs.read(`${$.plugin.root}/assets/viewer.js`),
      },
    }),
  )

  const published = await $.tool.call({
    tool: 'Artifact',
    file_path: pagePath,
    files,
    // Each export replaces the files this mod published before (user-approved):
    // its own config.json and transcript copies, never anything else.
    overwrite_unread: Object.keys(files),
    capabilities: { downloads: true },
    icon: 'archive',
    description: `Full JSONL transcripts and redacted configuration of Claude Code session ${id}.`,
  })
  if ('deny' in published && published.deny !== undefined) return `Publish refused: ${published.deny}`
  if (published.isError) return `Publish failed: ${published.text}`
  const url = (published.result as { url?: string } | undefined)?.url
  return [
    `Session export published: ${url ?? '(no url returned)'}`,
    `${downloads.length - 1} transcript file(s) attached.`,
    ...(skipped.length > 0 ? [`Too large to attach, local only: ${skipped.join(', ')}`] : []),
    'Transcripts can contain secrets read during the session: check before sharing.',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Publish an artifact with this session’s config and its full JSONL transcript to download',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    try {
      void $.ui.toast('Exporting session…')
      return { text: await exportSession($) }
    } catch (err) {
      return { text: `Session export failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
