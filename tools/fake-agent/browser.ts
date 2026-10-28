// The browser scenario: opens a page through OverBench's browser tools, waitFor its request for a
// new site to be answered, then reports what the call answered. The screenshots use it to show a
// new site's card and bar while it waits.

import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type { Scenario, Turn } from './turn.ts'

interface CallResult {
  text: string
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
 * `/open-site <url>` opens a site in the browser, which asks the user first for one it may not
 * open. The reply says how the call ended: the page it opened, or why the user's refusal kept it
 * from opening.
 */
export const openSite: Scenario = async (turn) => {
  const server = overbench(turn.session.mcpServers)
  const url = turn.text.trim() || 'https://example.com/'
  if (!server) {
    await say(turn, 'This session has no browser.')
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
  const callId = `open-site-${turn.session.turns}`
  await turn.send({
    sessionUpdate: 'tool_call',
    toolCallId: callId,
    title: `mcp__${server.name}__browser_navigate`,
    kind: 'fetch',
    status: 'in_progress',
    rawInput: { url },
    locations: [],
    content: [],
  })
  const call: Call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as { type: string; text?: string }[]
    return {
      text: content.find((block) => block.type === 'text')?.text ?? '',
      isError: result.isError === true,
    }
  }
  const opened = await call('browser_navigate', { url })
  await turn.send({
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status: opened.isError ? 'failed' : 'completed',
    content: [{ type: 'content', content: { type: 'text', text: opened.text } }],
  })
  await say(turn, opened.text)
  return 'end_turn'
}
