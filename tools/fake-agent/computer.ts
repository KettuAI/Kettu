// The computer scenario: one call of Kettu's computer use tools, shown as a tool call, then what
// it answered. It lets a run try computer use's checks, cards and bar without a model.

import type { Scenario } from './turn.ts'
import { kettu, say } from './browser.ts'

/**
 * `/computer <tool> [arguments]` calls a `computer_*` tool, such as
 * `/computer computer_list_windows {"pid": 123}`, and replies with its text and how many pictures
 * it gave.
 */
export const computer: Scenario = async (turn) => {
  const server = kettu(turn.session.mcpServers)
  const [name = 'computer_list_apps', ...rest] = turn.text.trim().split(/\s+/)
  let args: Record<string, unknown>
  try {
    args = rest.length > 0 ? (JSON.parse(rest.join(' ')) as Record<string, unknown>) : {}
  } catch {
    await say(turn, 'The arguments must be JSON, such as {"pid": 123}.')
    return 'end_turn'
  }
  if (!server) {
    await say(turn, 'This session has no Kettu service.')
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
  const callId = `computer-${turn.session.turns}`
  await turn.send({
    sessionUpdate: 'tool_call',
    toolCallId: callId,
    title: `mcp__${server.name}__${name}`,
    kind: 'other',
    status: 'in_progress',
    rawInput: args,
    locations: [],
    content: [],
  })
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })
  const content = result.content as {
    type: string
    text?: string
    data?: string
    mimeType?: string
  }[]
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  const images = content.filter((block) => block.type === 'image')
  await turn.send({
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status: result.isError ? 'failed' : 'completed',
    content: [
      { type: 'content', content: { type: 'text', text } },
      ...images.map((image) => ({
        type: 'content' as const,
        content: {
          type: 'image' as const,
          data: image.data ?? '',
          mimeType: image.mimeType ?? 'image/png',
        },
      })),
    ],
  })
  await client.close()
  await say(turn, `${text.slice(0, 4_000)}\n\n${images.length} picture(s).`)
  return 'end_turn'
}
