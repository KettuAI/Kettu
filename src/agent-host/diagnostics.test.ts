import { describe, expect, it } from 'vitest'
import { Diagnostics } from './diagnostics'

function recorded(message: unknown): string {
  const diagnostics = new Diagnostics()
  diagnostics.traffic('fake-agent', 'out', message)
  const [record] = diagnostics.agentRecords('fake-agent').traffic
  return JSON.stringify(record!.message)
}

describe('Diagnostics traffic', () => {
  it("masks the session's bearer of a server reached through Kettu's proxy", () => {
    const proxied = {
      type: 'http',
      name: 'linear',
      url: 'http://127.0.0.1:4567/proxy/0123456789abcdef01234567',
      headers: [{ name: 'Authorization', value: 'Bearer proxy-session-token' }],
    }
    const acp = recorded({
      id: 1,
      method: 'session/new',
      params: { cwd: '/r', mcpServers: [proxied] },
    })
    const codex = recorded({
      id: 2,
      method: 'thread/start',
      params: {
        config: {
          mcp_servers: {
            linear: {
              url: proxied.url,
              http_headers: { Authorization: 'Bearer proxy-session-token' },
            },
          },
        },
      },
    })
    for (const text of [acp, codex]) {
      expect(text).not.toContain('proxy-session-token')
      expect(text).toContain('/proxy/0123456789abcdef01234567')
    }
  })

  it("masks every header and environment value of ACP's MCP servers", () => {
    const text = recorded({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: {
        cwd: '/repo',
        mcpServers: [
          {
            type: 'http',
            name: 'kettu',
            url: 'http://127.0.0.1:9/mcp',
            headers: [{ name: 'Authorization', value: 'Bearer kettu-token' }],
          },
          {
            name: 'context7',
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp@4.6.0'],
            env: [{ name: 'CONTEXT7_API_KEY', value: 'c7-secret' }],
          },
          {
            type: 'sse',
            name: 'acme',
            url: 'https://mcp.acme.dev/sse',
            headers: [{ name: 'X-Plain-Looking', value: 'abc' }],
          },
        ],
      },
    })
    for (const secret of ['kettu-token', 'c7-secret', 'abc']) expect(text).not.toContain(secret)
    expect(JSON.parse(text).params.mcpServers).toEqual([
      expect.objectContaining({ headers: [{ name: 'Authorization', value: '<redacted>' }] }),
      expect.objectContaining({
        args: ['-y', '@upstash/context7-mcp@4.6.0'],
        env: [{ name: 'CONTEXT7_API_KEY', value: '<redacted>' }],
      }),
      expect.objectContaining({ headers: [{ name: 'X-Plain-Looking', value: '<redacted>' }] }),
    ])
  })

  it.each(['thread/start', 'thread/resume', 'thread/fork'])(
    "masks every header and environment value of Codex's MCP servers in %s",
    (method) => {
      const text = recorded({
        id: 7,
        method,
        params: {
          cwd: '/repo',
          config: {
            projects: { '/repo': { trust_level: 'trusted' } },
            mcp_servers: {
              github: {
                url: 'https://api.githubcopilot.com/mcp/',
                http_headers: { Authorization: 'Bearer ghp_secret' },
              },
              context7: {
                command: 'npx',
                args: ['-y', 'ctx'],
                env: { CONTEXT7_API_KEY: 'c7-secret', PLAIN: 'xyz' },
              },
            },
          },
        },
      })
      for (const secret of ['ghp_secret', 'c7-secret', 'xyz']) expect(text).not.toContain(secret)
      const { config } = JSON.parse(text).params
      expect(config.projects).toEqual({ '/repo': { trust_level: 'trusted' } })
      expect(config.mcp_servers).toEqual({
        github: {
          url: 'https://api.githubcopilot.com/mcp/',
          http_headers: { Authorization: '<redacted>' },
        },
        context7: {
          command: 'npx',
          args: ['-y', 'ctx'],
          env: { CONTEXT7_API_KEY: '<redacted>', PLAIN: '<redacted>' },
        },
      })
    },
  )

  it('keeps a message without servers as it was', () => {
    const message = { id: 2, method: 'turn/start', params: { input: [{ text: 'hi' }] } }
    expect(JSON.parse(recorded(message))).toEqual(message)
  })

  it('coalesces consecutive streaming delta messages when verbose and mirrorTraffic are off', () => {
    let time = 1_000
    const diagnostics = new Diagnostics({ now: () => ++time })
    diagnostics.traffic('claude-code', 'out', { method: 'query', sessionId: 's1' })
    for (let i = 0; i < 50; i++) {
      diagnostics.traffic('claude-code', 'in', {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'abcd' } },
      })
    }
    diagnostics.traffic('claude-code', 'in', { type: 'result', subtype: 'success' })

    const records = diagnostics.agentRecords('claude-code').traffic
    expect(records).toHaveLength(3)
    expect(records[0]!.message).toEqual({ method: 'query', sessionId: 's1' })
    expect(records[1]!.message).toEqual({
      coalesced: true,
      kind: 'stream_event/text_delta',
      count: 50,
      chars: 200,
      startedAt: 1_002,
      endedAt: 1_051,
    })
    expect(records[2]!.message).toEqual({ type: 'result', subtype: 'success' })
  })

  it('coalesces ACP and Codex streaming deltas and flushes them on export', () => {
    let time = 2_000
    const diagnostics = new Diagnostics({ now: () => ++time })
    for (let i = 0; i < 4; i++) {
      diagnostics.traffic('codex', 'in', {
        method: 'item/agentMessage/delta',
        params: { delta: 'hi!' },
      })
    }
    for (let i = 0; i < 3; i++) {
      diagnostics.traffic('codex', 'in', {
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'xy' } } },
      })
    }

    const records = diagnostics.agentRecords('codex').traffic
    expect(records).toHaveLength(2)
    expect(records[0]!.message).toMatchObject({
      coalesced: true,
      kind: 'item/agentMessage/delta',
      count: 4,
      chars: 12,
    })
    expect(records[1]!.message).toMatchObject({
      coalesced: true,
      kind: 'session/update/agent_message_chunk',
      count: 3,
      chars: 6,
    })
  })

  it('preserves individual streaming deltas when mirrorTraffic is enabled', () => {
    const lines: string[] = []
    const diagnostics = new Diagnostics({ mirrorTraffic: true, write: (line) => lines.push(line) })
    const delta = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } },
    }
    diagnostics.traffic('claude-code', 'in', delta)
    diagnostics.traffic('claude-code', 'in', delta)
    expect(lines).toHaveLength(2)
    expect(diagnostics.agentRecords('claude-code').traffic).toHaveLength(2)
  })
})
