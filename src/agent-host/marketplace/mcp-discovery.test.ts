import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMcpConfig, type ConfigLayout } from './mcp-config'
import { McpDiscoveryService, readMcpConfig, readOwnMcpServers } from './mcp-discovery'
import { parseMcpPaste } from './mcp-paste'
import { ALL_TRANSPORTS, libraryServers } from './servers'
import type { MarketServer } from '@shared/marketplace'

describe('MCP configuration readers', () => {
  it.each<[ConfigLayout, string]>([
    ['standard', '{"mcpServers":{"notes":{"command":"uvx","args":["notes"]}}}'],
    ['claude', '{"mcpServers":{"notes":{"command":"uvx","args":["notes"]}}}'],
    ['codex', '[mcp_servers.notes]\ncommand = "uvx"\nargs = ["notes"]'],
    ['opencode', '{/* comment */"mcp":{"notes":{"type":"local","command":["uvx","notes"]}}}'],
    ['opencode', '{"mcp":{"servers":{"notes":{"type":"local","command":["uvx","notes"]}}}}'],
    [
      'vscode',
      '{// comment\n"servers":{"notes":{"type":"stdio","command":"uvx","args":["notes"],}},}',
    ],
    ['zed', '{"context_servers":{"notes":{"command":{"path":"uvx","args":["notes"]}}}}'],
    ['yaml', 'mcp_servers:\n  notes:\n    command: uvx\n    args: [notes]'],
  ])('reads the %s layout without starting anything', (layout, text) => {
    expect(parseMcpConfig(text, { path: '/demo/config', layout })).toMatchObject({
      servers: [{ name: 'notes', spec: { type: 'stdio', command: 'uvx', args: ['notes'] } }],
    })
  })

  it('reads only the previously opened projects in a user configuration', () => {
    const text = JSON.stringify({
      projects: {
        '/opened': { mcpServers: { notes: { command: 'uvx' } } },
        '/other': { mcpServers: { ignored: { command: 'node' } } },
      },
    })
    expect(
      parseMcpConfig(text, { path: '/demo/config', layout: 'claude', projects: ['/opened'] }),
    ).toMatchObject({
      servers: [{ name: 'notes', source: { project: '/opened' } }],
    })
  })

  it('distinguishes missing, unreadable and malformed files without quoting their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kettu-mcp-config-'))
    try {
      const file = { path: join(root, 'demo.json'), layout: 'standard' as const }
      expect(await readMcpConfig(file)).toBeNull()
      expect(await readMcpConfig({ ...file, path: root })).toMatchObject({
        error: { reason: 'not-file' },
      })
      await writeFile(file.path, '{\ninvalid: "sensitive-literal"')
      const result = await readMcpConfig(file)
      expect(result).toMatchObject({ error: { reason: 'invalid-json', line: 2 } })
      expect(JSON.stringify(result)).not.toContain('sensitive-literal')
      expect(parseMcpConfig('[bad', { ...file, layout: 'codex' }).error?.reason).toBe(
        'invalid-toml',
      )
      expect(parseMcpConfig('broken: [', { ...file, layout: 'yaml' }).error?.reason).toBe(
        'invalid-yaml',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires a source when matching servers differ and returns no credential to the client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kettu-mcp-conflict-'))
    const files = ['first', 'second'].map((app) => ({
      app,
      path: join(root, app),
      layout: 'standard' as const,
    }))
    const service = new McpDiscoveryService({
      files: () => files,
      library: () => [],
      changed: () => {},
    })
    try {
      for (const { path, app } of files) {
        await writeFile(
          path,
          JSON.stringify({
            mcpServers: {
              notes: {
                url: 'https://mcp.example.com/mcp',
                headers: { Authorization: 'demo-literal-' + app, 'X-Ref': '${VARIABLE}' },
              },
            },
          }),
        )
      }
      const read = await service.scan()
      expect(read.servers).toHaveLength(1)
      expect(JSON.stringify(read)).not.toContain('demo-literal-')
      const row = read.servers[0]!
      expect(row.differentKeys).toEqual(['Authorization'])
      expect(row.sources.map(({ keys }) => keys)).toEqual([['Authorization'], ['Authorization']])
      const choice = { id: row.id, name: 'notes', agents: 'all' as const }
      expect(() => service.prepare([choice])).toThrow('Choose which configuration')
      const [selected] = service.prepare([{ ...choice, sourceId: row.sources[1]!.id }])
      expect(selected?.secrets).toEqual({ Authorization: 'demo-literal-second' })
      expect(JSON.stringify(selected?.server)).not.toContain('demo-literal-')
      expect(selected?.server.spec).toMatchObject({
        headers: [
          { name: 'Authorization', input: true },
          { name: 'X-Ref', value: '${VARIABLE}' },
        ],
      })
    } finally {
      service.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('MCP paste', () => {
  it('accepts a URL, the full command, and multiple JSON entries', () => {
    expect(parseMcpPaste('https://mcp.example.com/mcp')[0]?.spec).toMatchObject({ type: 'http' })
    expect(parseMcpPaste('npx -y demo@1.0 "folder with spaces"')[0]?.spec).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'demo@1.0', 'folder with spaces'],
    })
    const block =
      '{"mcpServers":{"one":{"url":"https://example.test"},"two":{"command":"uvx","env":{"PASSWORD":"demo-value"}}}}'
    const servers = parseMcpPaste(block)
    expect(servers.map(({ name }) => name)).toEqual(['one', 'two'])
    expect(JSON.stringify(servers[1]?.spec)).not.toContain('demo-value')
  })

  it('parses add commands and protects their headers and environment variables', () => {
    const remote = parseMcpPaste(
      'claude mcp add --transport http notes https://example.test -H "Authorization: Bearer demo-token"',
    )[0]!
    expect(remote).toMatchObject({
      name: 'notes',
      secrets: { Authorization: 'Bearer demo-token' },
      spec: { type: 'http' },
    })
    const local = parseMcpPaste('codex mcp add notes --env API_KEY=demo-token -- npx -y notes')[0]!
    expect(local).toMatchObject({
      name: 'notes',
      secrets: { API_KEY: 'demo-token' },
      spec: { type: 'stdio', args: ['-y', 'notes'] },
    })
  })

  it('does not echo malformed user input in parse errors', () => {
    expect(() => parseMcpPaste('{token="demo-token"')).toThrow('Enter a URL')
  })
})

it('hands the library copy under the configured name and reports a different same-named server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kettu-mcp-own-'))
  const file = { path: join(root, 'config.json'), layout: 'standard' as const }
  try {
    await writeFile(
      file.path,
      JSON.stringify({
        mcpServers: {
          configured: {
            command: 'npx',
            args: ['-y', 'fixture@1'],
            env: { API_KEY: 'fixture-key' },
          },
          conflict: { url: 'https://elsewhere.example.test/mcp' },
        },
      }),
    )
    const own = await readOwnMcpServers([file])
    expect(JSON.stringify(own)).not.toContain('fixture-key')
    const entry: MarketServer = {
      id: 'manual:configured',
      name: 'library',
      title: 'Fixture',
      source: 'manual',
      version: null,
      on: true,
      agents: 'all',
      spec: { type: 'stdio', command: 'npx', args: ['-y', 'fixture@2'], env: [] },
    }
    const conflict: MarketServer = {
      ...entry,
      id: 'manual:conflict',
      name: 'conflict',
      spec: {
        type: 'http',
        url: 'https://library.example.test/mcp',
        transport: 'streamable-http',
        headers: [],
      },
    }
    const collisions: string[] = []
    const offered = libraryServers([entry, conflict], new Map(), 'codex', ALL_TRANSPORTS, {
      platform: 'linux',
      own,
      router: { origin: 'http://127.0.0.1:12345', token: 'fixture', allow: () => {} },
      conflict: (_, name) => collisions.push(name),
    })
    expect(offered.map(({ name }) => name)).toEqual(['configured', 'conflict'])
    expect(
      offered.every(
        (server) => 'url' in server && server.url.startsWith('http://127.0.0.1:12345/'),
      ),
    ).toBe(true)
    expect(collisions).toEqual(['conflict'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
