import { describe, expect, it } from 'vitest'
import { Diagnostics } from './diagnostics'

function recorded(message: unknown): string {
  const diagnostics = new Diagnostics()
  diagnostics.traffic('fake-agent', 'out', message)
  const [record] = diagnostics.agentRecords('fake-agent').traffic
  return JSON.stringify(record!.message)
}

describe('Diagnostics traffic', () => {
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
})
