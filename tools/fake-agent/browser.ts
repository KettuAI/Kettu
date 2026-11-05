// The browser scenario: opens a page through Kettu's browser tools, waitFor its request for a
// new site to be answered, then reports what the call answered. The screenshots use it to show a
// new site's card and bar while it waits.

import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import type { Scenario, Turn } from './turn.ts'

interface CallResult {
  text: string
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
 * `/open-site <url>` opens a site in the browser, which asks the user first for one it may not
 * open. The reply says how the call ended: the page it opened, or why the user's refusal kept it
 * from opening.
 */
export const openSite: Scenario = async (turn) => {
  const server = kettu(turn.session.mcpServers)
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

/**
 * `/device <tool> <json>` calls one `device_*` tool, as an agent would, and reports its answer: the
 * text, and the screenshot as an image in the tool call.
 */
export const deviceTool: Scenario = async (turn) => {
  const server = kettu(turn.session.mcpServers)
  const text = turn.text.trim()
  const space = text.indexOf(' ')
  const name = space === -1 ? text : text.slice(0, space)
  let args: Record<string, unknown>
  try {
    args = space === -1 ? {} : (JSON.parse(text.slice(space + 1)) as Record<string, unknown>)
  } catch {
    await say(turn, 'The arguments are not JSON.')
    return 'end_turn'
  }
  if (!server || !name) {
    await say(turn, server ? 'Name a device tool.' : 'This session has no Kettu tools.')
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
  const callId = `device-${turn.session.turns}`
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
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })
  const content = result.content as {
    type: string
    text?: string
    data?: string
    mimeType?: string
  }[]
  const answer = content.find((block) => block.type === 'text')?.text ?? ''
  await turn.send({
    sessionUpdate: 'tool_call_update',
    toolCallId: callId,
    status: result.isError === true ? 'failed' : 'completed',
    content: content.map((block) =>
      block.type === 'image'
        ? {
            type: 'content',
            content: { type: 'image', data: block.data!, mimeType: block.mimeType! },
          }
        : { type: 'content', content: { type: 'text', text: block.text ?? '' } },
    ),
  })
  await say(turn, answer.length > 1500 ? `${answer.slice(0, 1500)}…` : answer)
  return 'end_turn'
}
