import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseMcpConfig, type ConfigLayout } from './mcp-config'
import { claudeProjectMcpPaths } from './mcp-config-paths'
import { McpDiscoveryService, readMcpConfig, readOwnMcpServers } from './mcp-discovery'
import { parseMcpPaste } from './mcp-paste'
import { ALL_TRANSPORTS, libraryServers, parseMarketKeys, serverHeaders } from './servers'
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

  it('reads Codex http_headers and merges them with headers, env_http_headers and bearer_token_env_var', () => {
    const text = [
      '[mcp_servers.inline]',
      'url = "https://mcp.example.com/inline"',
      'http_headers = { Authorization = "Bearer inline-secret", "X-Ref" = "${REF_VAR}", "X-Team" = "core" }',
      '',
      '[mcp_servers.combined]',
      'url = "https://mcp.example.com/combined"',
      'bearer_token_env_var = "BEARER_VAR"',
      '',
      '[mcp_servers.combined.headers]',
      '"X-Legacy" = "legacy-secret"',
      '"X-Override" = "from-headers"',
      '',
      '[mcp_servers.combined.http_headers]',
      'authorization = "Bearer stale-hardcoded"',
      '"x-override" = "from-http-headers"',
      '"X-Static" = "static-secret"',
      '"x-env-override" = "stale-literal"',
      '',
      '[mcp_servers.combined.env_http_headers]',
      '"X-Env-Override" = "OVERRIDE_VAR"',
      '"X-Env-Only" = "ONLY_VAR"',
    ].join('\n')

    const parsed = parseMcpConfig(text, { path: '/demo/.codex/config.toml', layout: 'codex' })
    expect(parsed.error).toBeUndefined()
    expect(parsed.servers).toHaveLength(2)

    const [inline, combined] = parsed.servers
    expect(inline).toMatchObject({
      name: 'inline',
      secrets: { Authorization: 'Bearer inline-secret', 'X-Team': 'core' },
      spec: {
        type: 'http',
        url: 'https://mcp.example.com/inline',
        headers: [
          { name: 'Authorization', input: true, secret: true, required: true },
          { name: 'X-Ref', value: '${REF_VAR}' },
          { name: 'X-Team', input: true, secret: true, required: true },
        ],
      },
    })

    // Precedence: headers < http_headers < env_http_headers < bearer_token_env_var,
    // deduplicated case-insensitively without keeping overridden literals in secrets.
    expect(combined).toMatchObject({
      name: 'combined',
      secrets: {
        'X-Legacy': 'legacy-secret',
        'x-override': 'from-http-headers',
        'X-Static': 'static-secret',
      },
      spec: {
        type: 'http',
        url: 'https://mcp.example.com/combined',
        headers: [
          { name: 'X-Legacy', input: true, secret: true, required: true },
          { name: 'x-override', input: true, secret: true, required: true },
          { name: 'Authorization', value: 'Bearer ${BEARER_VAR}' },
          { name: 'X-Static', input: true, secret: true, required: true },
          { name: 'X-Env-Override', value: '${OVERRIDE_VAR}' },
          { name: 'X-Env-Only', value: '${ONLY_VAR}' },
        ],
      },
    })
  })

  it('rejects malformed http_headers without leaking values', () => {
    const badType = parseMcpConfig(
      '[mcp_servers.api]\nurl = "https://mcp.example.com/mcp"\nhttp_headers = "secret-token"\n',
      { path: '/demo/.codex/config.toml', layout: 'codex' },
    )
    expect(badType.servers).toEqual([])
    expect(badType.error?.reason).toBe('invalid-server')
    expect(JSON.stringify(badType)).not.toContain('secret-token')

    const badValue = parseMcpConfig(
      '[mcp_servers.api]\nurl = "https://mcp.example.com/mcp"\nhttp_headers = { Authorization = 123 }\n',
      { path: '/demo/.codex/config.toml', layout: 'codex' },
    )
    expect(badValue.servers).toEqual([])
    expect(badValue.error?.reason).toBe('invalid-server')
  })

  it('flags Codex http_headers keys during discovery, detects cross-agent differences and forwards imported headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kettu-codex-headers-'))
    const codexFile = {
      agentId: 'codex' as const,
      path: join(root, 'config.toml'),
      layout: 'codex' as const,
    }
    const claudeFile = {
      agentId: 'claude-code' as const,
      path: join(root, '.claude.json'),
      layout: 'claude' as const,
    }
    const service = new McpDiscoveryService({
      files: () => [codexFile, claudeFile],
      library: () => [],
      changed: () => {},
    })
    try {
      await writeFile(
        codexFile.path,
        [
          '[mcp_servers.remote]',
          'url = "https://mcp.example.com/mcp"',
          'bearer_token_env_var = "API_BEARER"',
          '',
          '[mcp_servers.remote.http_headers]',
          '"X-Api-Key" = "codex-secret-key"',
          '"X-Workspace" = "eng"',
          '',
          '[mcp_servers.remote.env_http_headers]',
          '"X-Env-Header" = "EXTRA_HEADER"',
        ].join('\n'),
      )
      await writeFile(
        claudeFile.path,
        JSON.stringify({
          mcpServers: {
            remote: {
              url: 'https://mcp.example.com/mcp',
              headers: { 'X-Api-Key': 'claude-secret-key', 'X-Workspace': 'eng' },
            },
          },
        }),
      )

      const discovered = await service.scan()
      expect(discovered.servers).toHaveLength(1)
      expect(JSON.stringify(discovered)).not.toContain('codex-secret-key')
      expect(JSON.stringify(discovered)).not.toContain('claude-secret-key')
      const row = discovered.servers[0]!
      expect(row.differentKeys).toEqual(['X-Api-Key'])
      const codexSource = row.sources.find((source) => source.agentId === 'codex')!
      expect(codexSource.keys).toEqual(['X-Api-Key', 'X-Workspace'])

      const [prepared] = service.prepare([
        { id: row.id, sourceId: codexSource.id, name: 'remote', agents: ['codex'] },
      ])
      expect(prepared?.secrets).toEqual({
        'X-Api-Key': 'codex-secret-key',
        'X-Workspace': 'eng',
      })
      expect(JSON.stringify(prepared?.server)).not.toContain('codex-secret-key')

      const held = parseMarketKeys({ [prepared!.server.id]: prepared!.secrets })!
      expect(
        serverHeaders(prepared!.server, held, {
          env: { API_BEARER: 'env-bearer', EXTRA_HEADER: 'env-extra' },
          platform: 'darwin',
        }),
      ).toEqual({
        'X-Api-Key': 'codex-secret-key',
        'X-Workspace': 'eng',
        'X-Env-Header': 'env-extra',
        Authorization: 'Bearer env-bearer',
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

it('skips Claude Code servers disabled for the session project when reading own servers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kettu-claude-disabled-'))
  const file = {
    path: join(root, '.claude.json'),
    layout: 'claude' as const,
    projects: ['/repo'],
  }
  try {
    const text = JSON.stringify({
      mcpServers: {
        disabledUser: { url: 'https://api.githubcopilot.com/mcp/' },
        activeUser: { url: 'https://active.example.test/mcp' },
      },
      projects: {
        '/repo': {
          mcpServers: {
            disabledLocal: { command: 'local-db' },
            activeLocal: { command: 'local-ok' },
          },
          disabledMcpServers: ['disabledUser', 'disabledLocal'],
        },
      },
    })
    await writeFile(file.path, text)
    // Discovery still lists all configured entries without respectProjectDisabled.
    expect(parseMcpConfig(text, file).servers.map((server) => server.name)).toEqual([
      'disabledUser',
      'activeUser',
      'disabledLocal',
      'activeLocal',
    ])
    // Per-session own lookup excludes entries disabled for `/repo`.
    const own = await readOwnMcpServers([file])
    expect(own.map((server) => server.name)).toEqual(['activeUser', 'activeLocal'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reads Claude project .mcp.json ancestors so nearer entries win', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kettu-claude-proj-'))
  const nested = join(root, 'packages', 'app')
  try {
    await mkdir(nested, { recursive: true })
    await writeFile(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          shared: { url: 'https://root.example.test/mcp' },
          override: { command: 'old-cmd' },
        },
      }),
    )
    await writeFile(
      join(nested, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          override: { command: 'new-cmd' },
        },
      }),
    )
    const own = await readOwnMcpServers(claudeProjectMcpPaths(nested, 'darwin'))
    expect(own).toEqual([
      { name: 'shared', endpoint: { type: 'http', url: 'https://root.example.test/mcp' } },
      { name: 'override', endpoint: { type: 'stdio', command: 'new-cmd', args: [] } },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
