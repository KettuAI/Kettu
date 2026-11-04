// The artifacts scenario: calls Kettu's artifacts service through the MCP servers the session
// was attached with, as a real agent's MCP client would, and reports each call in the thread.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type { Scenario, Turn } from './turn.ts'

export const CANVAS_TITLE = 'Fake canvas'
export const SITE_TITLE = 'Fake site'

const DOCUMENT = [
  '# Fake report',
  '',
  'A document made from a type: Kettu shows it in a reading layout, and exports it to **Word** ' +
    'and *Markdown*. See [the project](https://github.com/KettuAI/Kettu).',
  '',
  '## What it holds',
  '',
  '- Headings, paragraphs and lists',
  '  - nested points',
  '- [x] task lists',
  '',
  '| Part | State |',
  '| --- | --- |',
  '| Viewer | Done |',
  '| Export | Done |',
  '',
  '> A quote, set apart.',
  '',
  '```ts',
  "const greeting = 'hello'",
  '```',
  '',
].join('\n')

const DECK = {
  title: 'Fake deck',
  slides: [
    { layout: 'title', title: 'Fake deck', subtitle: 'Made from the slides type' },
    { layout: 'section', title: 'Results', subtitle: 'What changed' },
    {
      layout: 'bullets',
      title: 'Why types',
      bullets: ['Agents write content', { text: 'Kettu lays it out', bullets: ['and exports it'] }],
    },
    {
      layout: 'two-column',
      title: 'Before and after',
      left: { heading: 'Before', bullets: ['Hand-made HTML'] },
      right: { heading: 'After', text: 'A deck in JSON.' },
    },
    {
      layout: 'stats',
      title: 'In numbers',
      stats: [
        { value: '8', label: 'layouts' },
        { value: '2', label: 'exports' },
      ],
    },
    { layout: 'quote', quote: 'It just works.', attribution: 'A tester', notes: 'Pause here.' },
    {
      layout: 'table',
      title: 'Formats',
      columns: ['Type', 'Exports'],
      rows: [
        ['Document', 'Word, Markdown'],
        ['Slides', 'PowerPoint, PDF'],
      ],
    },
  ],
}

/** The document, with a picture of the project when there is one. */
function documentWith(picture: string | null): string {
  return picture ? `${DOCUMENT}\n![A picture](${picture})\n` : DOCUMENT
}

/** The deck, with a slide of a picture of the project when there is one. */
function deckWith(picture: string | null): object {
  if (!picture) return DECK
  const slide = { layout: 'image', title: 'A picture', image: picture, alt: 'A picture' }
  return { ...DECK, slides: [...DECK.slides, slide] }
}

/** A page of several files: its style, its script and an image the host reads from the project. */
function siteFiles(image: string): Record<string, unknown>[] {
  const name = image.split(/[\\/]/).at(-1) ?? 'image'
  return [
    {
      path: 'index.html',
      content: [
        '<!doctype html>',
        '<html><head><title>Fake site</title>',
        '<link rel="stylesheet" href="styles/site.css"></head>',
        `<body><h1>Fake site</h1><img src="assets/${name}" alt="">`,
        '<p id="status">The script has not run.</p>',
        '<script src="scripts/site.js"></script></body></html>',
      ].join('\n'),
    },
    {
      path: 'styles/site.css',
      content: 'body{font:16px system-ui;margin:2rem}h1{color:#c2410c}img{max-width:12rem}',
    },
    {
      path: 'scripts/site.js',
      content: "document.getElementById('status').textContent = 'The script ran.'\n",
    },
    { path: `assets/${name}`, source: image },
  ]
}

const CANVAS = [
  '<!doctype html>',
  '<html><head><title>Fake canvas</title></head>',
  '<body>',
  '  <div data-page-group="Sign in">',
  '    <section data-page="A" data-page-size="390x844"><h1>Sign in, revision 1</h1></section>',
  '    <section data-page="B" data-page-size="390x844"><h1>Sign in B</h1></section>',
  '  </div>',
  '</body></html>',
].join('\n')

/** What a `--from` folder's `artifact.json` may say. */
interface FolderSpec {
  title?: unknown
  capabilities?: unknown
  type?: unknown
}

const SPEC_FILE = 'artifact.json'

/**
 * The call that makes an artifact of `folder`, inside the session's working folder: its
 * `artifact.json` names the title and what it declares or the type it is made from, and every
 * other file, hidden ones aside, is one of its files, which the host reads from the folder.
 */
async function folderCall(
  cwd: string,
  folder: string,
): Promise<{ name: string; args: Record<string, unknown> }> {
  const root = path.resolve(cwd, folder)
  const spec = JSON.parse(
    await readFile(path.join(root, SPEC_FILE), 'utf8').catch(() => '{}'),
  ) as FolderSpec
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .filter((rel) => rel !== SPEC_FILE && !rel.split(path.sep).some((part) => part.startsWith('.')))
    .sort()
    .map((rel) => ({ path: rel.split(path.sep).join('/'), source: path.join(root, rel) }))
  const title = typeof spec.title === 'string' ? spec.title : path.basename(root)
  if (spec.type === 'document' || spec.type === 'slides') {
    return { name: 'create_artifact_from_type', args: { type: spec.type, title, files } }
  }
  const capabilities = Array.isArray(spec.capabilities) ? { capabilities: spec.capabilities } : {}
  return { name: 'create_artifact', args: { title, files, ...capabilities } }
}

interface CallResult {
  text: string
  value: Record<string, unknown>
  isError: boolean
}

type Call = (name: string, args: Record<string, unknown>) => Promise<CallResult>

function kettu(servers: readonly McpServer[]): Extract<McpServer, { type: 'http' }> | null {
  for (const server of servers) {
    if ('type' in server && server.type === 'http' && server.name.startsWith('kettu')) {
      return server
    }
  }
  return null
}

async function say(turn: Turn, text: string): Promise<void> {
  await turn.send({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    messageId: turn.messageId(),
  })
}

/**
 * `/artifacts` makes "Fake canvas" in the project, or changes the one there with an edit, then
 * reads it back; `/artifacts --read <id>` reads that artifact, and `/artifacts --site <image>`
 * makes "Fake site" of several files, the image read by the host from the project; `--type
 * document` or `--type slides` makes "Fake report" or "Fake deck" from that type, with the
 * `--site` image in it when given. `--from <folder>`, which may repeat, makes one artifact of each
 * folder of the project: an `artifact.json` there may give `title`, `capabilities` and `type`, and
 * every other file is one of its files. Each call shows as a tool call named as Claude Code names MCP
 * tools, and the reply lists what each call returned. With
 * `--until-cancel` the turn runs on after the reply until it is cancelled, whatever the pace.
 *
 * Every call names its session in `_meta`, as OpenCode's do. `--child <id>` makes the calls a
 * subagent's: its tool calls come on this session with OpenCode's child-session `_meta`, and the
 * calls name the child. `--meta <id>` names another session instead, and `--meta none` none.
 * `--execute` makes every call from one `execute` tool call, as OpenCode's Code Mode does, and
 * writes the canvas once more after making or changing it.
 */
export const artifacts: Scenario = async (turn) => {
  const server = kettu(turn.session.mcpServers)
  if (!server) {
    await say(turn, 'This session has no artifacts service.')
    return 'end_turn'
  }
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ])
  const client = new Client({ name: 'fake-agent', version: '0.1.0' })
  const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]))
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
  )
  const lines: string[] = []
  const { child } = turn.options
  const named = turn.options.meta ?? child ?? turn.session.id
  const meta = named === 'none' ? undefined : { 'ai.opencode/sessionID': named }
  // OpenCode sends a subagent's updates on the session it runs under, marked as the child's.
  const childMeta = child
    ? { 'opencode/child-session': { id: child, parentID: turn.session.id, depth: 1 } }
    : undefined
  let n = 0
  const { execute } = turn.options
  const codeCallId = `execute-${turn.session.turns}`
  if (execute) {
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId: codeCallId,
      title: 'execute',
      kind: 'other',
      status: 'in_progress',
      rawInput: { code: 'await tools.kettu.create_artifact({ ... })' },
    })
  }
  const call: Call = async (name, args) => {
    const id = `${server.name}-${turn.session.turns}-${++n}`
    const toolCallId = child ? `${child}:${id}` : id
    if (execute) {
      const result = await client.callTool({
        name,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      })
      const content = result.content as { type: string; text?: string }[]
      const text = content.find((block) => block.type === 'text')?.text ?? ''
      lines.push(`${name}: ${text}`)
      return {
        text,
        value: (result.structuredContent ?? {}) as Record<string, unknown>,
        isError: result.isError === true,
      }
    }
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `mcp__${server.name}__${name}`,
      kind: 'other',
      status: 'in_progress',
      rawInput: args,
      ...(childMeta ? { _meta: childMeta } : {}),
    })
    let text: string
    let value: Record<string, unknown> = {}
    let isError: boolean
    try {
      const result = await client.callTool({
        name,
        arguments: args,
        ...(meta ? { _meta: meta } : {}),
      })
      const content = result.content as { type: string; text?: string }[]
      text = content.find((block) => block.type === 'text')?.text ?? ''
      value = (result.structuredContent ?? {}) as Record<string, unknown>
      isError = result.isError === true
    } catch (error) {
      text = (error as Error).message
      isError = true
    }
    await turn.send({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: isError ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text } }],
      ...(childMeta ? { _meta: childMeta } : {}),
    })
    lines.push(`${name}: ${text}`)
    return { text, value, isError }
  }
  try {
    const { read, site, type, from } = turn.options
    if (read) {
      await call('read_artifact', { id: read })
    } else if (from.length > 0) {
      for (const folder of from) {
        try {
          const made = await folderCall(turn.session.cwd, folder)
          await call(made.name, made.args)
        } catch (error) {
          lines.push(`${folder}: ${(error as Error).message}`)
        }
      }
    } else if (type) {
      await call('list_artifact_types', {})
      await call('read_artifact_type', { type })
      const picture = site ? `images/${site.split(/[\\/]/).at(-1) ?? 'image'}` : null
      const content =
        type === 'slides'
          ? { path: 'slides.json', content: JSON.stringify(deckWith(picture), null, 2) }
          : { path: 'document.md', content: documentWith(picture) }
      const created = await call('create_artifact_from_type', {
        type,
        title: type === 'slides' ? 'Fake deck' : 'Fake report',
        files: picture ? [content, { path: picture, source: site }] : [content],
      })
      if (!created.isError) await call('read_artifact', { id: String(created.value.id) })
    } else if (site) {
      const created = await call('create_artifact', { title: SITE_TITLE, files: siteFiles(site) })
      if (!created.isError) await call('read_artifact', { id: String(created.value.id) })
    } else {
      const listed = await call('list_artifacts', { query: CANVAS_TITLE })
      const found = (listed.value.artifacts as { id: string; version: number }[] | undefined)?.[0]
      let id: string
      if (found) {
        id = found.id
        await call('update_artifact', {
          id,
          base_version: found.version,
          edits: [
            {
              old_text: `revision ${found.version}<`,
              new_text: `revision ${found.version + 1}<`,
            },
          ],
          note: `Revision ${found.version + 1}`,
        })
      } else {
        const created = await call('create_artifact', { title: CANVAS_TITLE, html: CANVAS })
        id = String(created.value.id)
      }
      if (execute) {
        const { value } = await call('read_artifact', { id })
        const version = Number(value.version)
        await call('update_artifact', {
          id,
          base_version: version,
          edits: [{ old_text: `revision ${version}<`, new_text: `revision ${version + 1}<` }],
          note: `Revision ${version + 1}`,
        })
      }
      const back = await call('read_artifact', { id })
      const html = String(back.value.text ?? '')
      lines.push(`html: ${/revision \d+/.exec(html)?.[0] ?? 'no revision'}`)
    }
    if (execute) {
      await turn.send({
        sessionUpdate: 'tool_call_update',
        toolCallId: codeCallId,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: lines.join('\n') } }],
      })
    }
  } finally {
    await client.close()
  }
  await say(turn, lines.join('\n'))
  if (!turn.options.untilCancel) return 'end_turn'
  await new Promise<void>((resolve) => {
    if (turn.signal.aborted) resolve()
    else turn.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  return 'cancelled'
}
