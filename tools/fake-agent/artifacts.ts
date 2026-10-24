// The artifacts scenario: calls OverBench's artifacts service through the MCP servers the session
// was attached with, as a real agent's MCP client would, and reports each call in the thread.

import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type { Scenario, Turn } from './turn.ts'

export const CANVAS_TITLE = 'Fake canvas'

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

interface CallResult {
  text: string
  value: Record<string, unknown>
  isError: boolean
}

type Call = (name: string, args: Record<string, unknown>) => Promise<CallResult>

function overbench(servers: readonly McpServer[]): Extract<McpServer, { type: 'http' }> | null {
  for (const server of servers) {
    if ('type' in server && server.type === 'http' && server.name.startsWith('overbench')) {
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
 * reads it back; `/artifacts --read <id>` reads that artifact. Each call shows as a tool call
 * named as Claude Code names MCP tools, and the reply lists what each call returned. With
 * `--until-cancel` the turn runs on after the reply until it is cancelled, whatever the pace.
 *
 * Every call names its session in `_meta`, as OpenCode's do. `--child <id>` makes the calls a
 * subagent's: its tool calls come on this session with OpenCode's child-session `_meta`, and the
 * calls name the child. `--meta <id>` names another session instead, and `--meta none` none.
 */
export const artifacts: Scenario = async (turn) => {
  const server = overbench(turn.session.mcpServers)
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
  const call: Call = async (name, args) => {
    const id = `${server.name}-${turn.session.turns}-${++n}`
    const toolCallId = child ? `${child}:${id}` : id
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
    const read = turn.options.read
    if (read) {
      await call('read_artifact', { id: read })
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
      const back = await call('read_artifact', { id })
      const html = String(back.value.html ?? '')
      lines.push(`html: ${/revision \d+/.exec(html)?.[0] ?? 'no revision'}`)
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
