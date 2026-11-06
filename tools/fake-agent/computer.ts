// The computer scenario: calls of Kettu's computer use tools, each shown as a tool call, then what
// they answered. It lets a run try computer use's checks, cards and label without a model.

import type { Scenario } from './turn.ts'
import { kettu, say } from './browser.ts'

/** The longest pause a `wait` step takes, so a typo cannot hold a turn for long. */
const MAX_WAIT_MS = 120_000

type Step = { wait: number } | { name: string; args: Record<string, unknown> }

/** The steps of `<tool> [arguments] ; wait <ms> ; ...`, or why they cannot be read. */
function steps(text: string): Step[] | string {
  const parts = text.trim() ? text.split(/\s+;\s+/) : ['computer_list_apps']
  const out: Step[] = []
  for (const part of parts) {
    const [name = 'computer_list_apps', ...rest] = part.trim().split(/\s+/)
    if (name === 'wait') {
      const ms = Number(rest[0])
      if (!Number.isFinite(ms) || ms < 0) return 'A wait takes milliseconds, such as wait 5000.'
      out.push({ wait: Math.min(ms, MAX_WAIT_MS) })
      continue
    }
    try {
      const args = rest.length > 0 ? (JSON.parse(rest.join(' ')) as Record<string, unknown>) : {}
      out.push({ name, args })
    } catch {
      return 'The arguments must be JSON, such as {"pid": 123}.'
    }
  }
  return out
}

/**
 * `/computer <tool> [arguments]` calls a `computer_*` tool, such as
 * `/computer computer_list_windows {"pid": 123}`, and replies with its text and how many pictures
 * it gave. Calls separated by ` ; ` run in turn, and `wait <ms>` holds the turn between them, as
 * an agent looking at a window does.
 */
export const computer: Scenario = async (turn) => {
  const server = kettu(turn.session.mcpServers)
  const plan = steps(turn.text)
  if (typeof plan === 'string') {
    await say(turn, plan)
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
  const replies: string[] = []
  for (const [i, step] of plan.entries()) {
    if ('wait' in step) {
      await new Promise((resolve) => setTimeout(resolve, step.wait))
      continue
    }
    const callId = `computer-${turn.session.turns}-${i}`
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId: callId,
      title: `mcp__${server.name}__${step.name}`,
      kind: 'other',
      status: 'in_progress',
      rawInput: step.args,
      locations: [],
      content: [],
    })
    const result = await client.callTool({ name: step.name, arguments: step.args }, undefined, {
      timeout: 360_000,
    })
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
    replies.push(`${text.slice(0, 4_000)}\n\n${images.length} picture(s).`)
  }
  await client.close()
  await say(turn, replies.join('\n\n---\n\n') || 'Nothing was called.')
  return 'end_turn'
}
