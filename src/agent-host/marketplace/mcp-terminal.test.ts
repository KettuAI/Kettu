import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/agents'
import type { MarketServer } from '@shared/marketplace'
import { parse as parseToml } from '@decimalturn/toml-patch'
import { parse as parseJsonc } from 'jsonc-parser'
import {
  CONNECT_FILE,
  McpTerminal,
  McpTerminalStale,
  seal,
  terminalLedgerFile,
  unseal,
  withClaudeLock,
  writeConnectFile,
  type McpTerminalDeps,
  type TerminalOwner,
} from './mcp-terminal'
import { bridgeEntry, editServers, isBridgeEntry, mergeList } from './mcp-terminal-files'
import { parseMcpConfig, type McpConfigFile } from './mcp-config'

const BRIDGE = '/Applications/Kettu.app/Contents/Resources/helpers/kettu-mcp-bridge'
const SECRET = 'ghp_secret_value_1234'

describe('editing an agent file', () => {
  it('changes only the entries, keeping comments and the other keys', () => {
    const text =
      '{\n  // mine\n  "theme": "dark",\n  "mcpServers": {\n    "a": { "command": "npx" }\n  }\n}\n'
    const next = editServers(
      text,
      'json',
      ['mcpServers'],
      [
        { name: 'a', value: { command: BRIDGE, args: ['mcp', 'connect', 'a'] } },
        { name: 'b', value: { command: BRIDGE, args: ['mcp', 'connect', 'b'] } },
      ],
    )
    expect(next).toContain('// mine')
    expect(next).toContain('"theme": "dark"')
    expect(parseJsonc(next).mcpServers.b.args).toEqual(['mcp', 'connect', 'b'])
  })

  it('appends new TOML tables and removes old ones, keeping the rest', () => {
    const text = '# top\nmodel = "x"\n\n[mcp_servers.a]\ncommand = "npx" # mine\n\n[other]\nx = 1\n'
    const added = editServers(
      text,
      'toml',
      ['mcp_servers'],
      [{ name: 'b', value: { command: BRIDGE, args: ['mcp', 'connect', 'b'] } }],
    )
    expect(added).toContain('# mine')
    expect(added).toContain('[mcp_servers.b]')
    expect(parseToml(added)).toMatchObject({ model: 'x', other: { x: 1 } })
    const removed = editServers(added, 'toml', ['mcp_servers'], [{ name: 'a', value: undefined }])
    expect(removed).not.toContain('[mcp_servers.a]')
    expect(removed).toContain('# top')
    expect(Object.keys((parseToml(removed) as { mcp_servers: object }).mcp_servers)).toEqual(['b'])
  })

  it('leaves the text alone when nothing changes', () => {
    const text = '{ "mcpServers": {} }'
    expect(editServers(text, 'json', ['mcpServers'], [])).toBe(text)
  })

  it('keeps the user items of a list setting where they were', () => {
    expect(mergeList(['Bash(rm:*)', 'mcp__a__x'], ['mcp__a__x'], ['mcp__a__y'])).toEqual([
      'Bash(rm:*)',
      'mcp__a__y',
    ])
    expect(mergeList(['Bash(rm:*)'], [], [])).toBeNull()
  })

  it("puts Kettu's turned-off tools in Windsurf's and Devin Desktop's entries alone", () => {
    const args = ['mcp', 'connect', 'a']
    expect(bridgeEntry('standard', { app: 'windsurf' }, BRIDGE, args, ['wipe'])).toEqual({
      command: BRIDGE,
      args,
      disabledTools: ['wipe'],
    })
    expect(bridgeEntry('standard', { app: 'devin' }, BRIDGE, args, ['wipe'])).toEqual({
      command: BRIDGE,
      args,
      disabledTools: ['wipe'],
    })
    expect(bridgeEntry('standard', { app: 'cursor' }, BRIDGE, args, ['wipe'])).toEqual({
      command: BRIDGE,
      args,
    })
  })

  it('knows its own bridge entries, whichever copy runs them', () => {
    expect(isBridgeEntry({ command: BRIDGE, args: ['mcp', 'connect', 'a'] })).toBe(true)
    expect(isBridgeEntry({ type: 'local', command: ['/x/kettu', 'mcp', 'connect', 'a'] })).toBe(
      true,
    )
    expect(isBridgeEntry({ command: 'npx', args: ['mcp', 'connect'] })).toBe(false)
  })
})

describe('sealed copies', () => {
  it('open only with the key that sealed them', () => {
    const key = Buffer.alloc(32, 7)
    const sealed = seal(key, SECRET)
    expect(sealed.toString('utf8')).not.toContain(SECRET)
    expect(unseal(key, sealed)).toBe(SECRET)
    expect(() => unseal(Buffer.alloc(32, 8), sealed)).toThrow()
  })
})

describe("Claude Code's lock", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kettu-claude-lock-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('waits while Claude Code holds it and takes it back once stale', async () => {
    const file = join(root, '.claude.json')
    await mkdir(`${file}.lock`)
    const old = new Date(Date.now() - 60_000)
    await utimes(`${file}.lock`, old, old)
    let ran = false
    await withClaudeLock(file, async () => {
      ran = true
      expect((await stat(`${file}.lock`)).isDirectory()).toBe(true)
    })
    expect(ran).toBe(true)
    await expect(stat(`${file}.lock`)).rejects.toThrow()
  })
})

interface Fixture {
  root: string
  home: string
  deps: McpTerminalDeps
  library: MarketServer[]
  terminal: McpTerminal
  imports: number
}

async function fixture(owner: TerminalOwner, file: McpConfigFile): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'kettu-mcp-terminal-'))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const data = join(root, 'data')
  const library: MarketServer[] = []
  const state = { imports: 0 }
  const deps: McpTerminalDeps = {
    dataPath: data,
    log: () => {},
    ledger: terminalLedgerFile(data, () => {}),
    library: () => library,
    owners: async () => [owner],
    files: () => [{ ...file, path: join(home, file.path) }],
    claudeSettings: () => join(home, '.claude', 'settings.json'),
    launch: () => ({ command: BRIDGE, args: ['mcp', 'connect'] }),
    dataArg: () => null,
    key: () => Buffer.alloc(32, 3),
    importOwn: async (target, items) => {
      state.imports += items.length
      const configPath = join(home, file.path)
      const parsed = parseMcpConfig(await readFile(configPath, 'utf8'), {
        ...file,
        path: configPath,
      })
      for (const { source, name } of items) {
        const matched = parsed.servers.find((entry) => entry.name === source.entryName)
        library.push({
          id: `manual:${name}`,
          name,
          title: name,
          source: 'manual',
          version: null,
          spec: matched?.spec ?? {
            type: 'stdio',
            command: 'npx',
            args: ['-y', `${name}-mcp`],
            env: [],
          },
          agents: target.startsWith('app:') ? 'all' : [target as AgentId],
          on: true,
        })
      }
    },
    giveTo: async () => {},
    changed: () => {},
  }
  const out = {
    root,
    home,
    deps,
    library,
    terminal: new McpTerminal(deps),
    get imports() {
      return state.imports
    },
  }
  return out
}

const CLAUDE: TerminalOwner = {
  id: 'claude-code' as AgentId,
  harness: 'claude-code',
  app: null,
  folder: null,
}

describe('a takeover of Claude Code', () => {
  let f: Fixture
  const claudeJson = () => join(f.home, '.claude.json')
  const read = async () => JSON.parse(await readFile(claudeJson(), 'utf8'))

  beforeEach(async () => {
    f = await fixture(CLAUDE, { path: '.claude.json', layout: 'claude', agentId: CLAUDE.id })
    await writeFile(
      claudeJson(),
      JSON.stringify(
        {
          numStartups: 3,
          mcpServers: {
            sentry: {
              command: 'npx',
              args: ['-y', 'sentry-mcp'],
              env: { SENTRY_TOKEN: SECRET },
            },
          },
          projects: { '/p': { mcpServers: { local: { command: 'x' } } } },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    f.library.push({
      id: 'linear',
      name: 'linear',
      title: 'Linear',
      source: 'registry',
      version: null,
      spec: {
        type: 'http',
        url: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        headers: [],
      },
      agents: 'all',
      on: true,
      toolsOff: ['delete_issue'],
    })
  })
  afterEach(async () => {
    await rm(f.root, { recursive: true, force: true })
  })

  it('imports its own servers, then writes bridge entries holding no key, port or token', async () => {
    const plan = await f.terminal.plan(CLAUDE.id)
    expect(plan.imports.map(({ name, keys }) => [name, keys])).toEqual([['sentry', true]])
    expect(plan.entries).toEqual([
      { name: 'sentry', replaces: true },
      { name: 'linear', replaces: false },
    ])
    expect(JSON.stringify(plan)).not.toContain(SECRET)
    await f.terminal.turnOn(CLAUDE.id, plan.id)
    const config = await read()
    expect(config.numStartups).toBe(3)
    expect(config.projects['/p'].mcpServers.local).toEqual({ command: 'x' })
    expect(config.mcpServers.sentry).toEqual({
      type: 'stdio',
      command: BRIDGE,
      args: ['mcp', 'connect', 'sentry', '--agent', 'claude-code'],
      env: {},
    })
    expect(config.mcpServers.linear.args).toEqual([
      'mcp',
      'connect',
      'linear',
      '--agent',
      'claude-code',
    ])
    const text = await readFile(claudeJson(), 'utf8')
    expect(text).not.toContain(SECRET)
    expect(text).not.toMatch(/127\.0\.0\.1|token|Bearer/i)
    expect((await stat(claudeJson())).mode & 0o777).toBe(0o600)
    const settings = JSON.parse(await readFile(join(f.home, '.claude', 'settings.json'), 'utf8'))
    expect(settings.permissions.deny).toEqual(['mcp__linear__delete_issue'])
    // Every backup is sealed: the key the file had is nowhere in Kettu's data in the clear.
    const sealed = await readdir(join(f.root, 'data', 'mcp-terminal'))
    expect(sealed.length).toBeGreaterThan(0)
    for (const name of sealed) {
      expect(
        (await readFile(join(f.root, 'data', 'mcp-terminal', name))).toString('latin1'),
      ).not.toContain(SECRET)
    }
    expect(
      await readFile(join(f.root, 'data', 'state', 'mcp-terminal.json'), 'utf8'),
    ).not.toContain(SECRET)
  })

  it('refuses a plan the file changed since', async () => {
    const plan = await f.terminal.plan(CLAUDE.id)
    const config = await read()
    config.mcpServers.extra = { command: 'y' }
    await writeFile(claudeJson(), JSON.stringify(config))
    await expect(f.terminal.turnOn(CLAUDE.id, plan.id)).rejects.toBeInstanceOf(McpTerminalStale)
  })

  it('writes nothing when nothing changed', async () => {
    await f.terminal.turnOn(CLAUDE.id, (await f.terminal.plan(CLAUDE.id)).id)
    const before = await stat(claudeJson())
    const backups = (await f.terminal.backups(CLAUDE.id)).length
    await f.terminal.sync()
    expect((await stat(claudeJson())).mtimeMs).toBe(before.mtimeMs)
    expect((await f.terminal.backups(CLAUDE.id)).length).toBe(backups)
  })

  it('never writes back an entry changed outside Kettu, and asks', async () => {
    await f.terminal.turnOn(CLAUDE.id, (await f.terminal.plan(CLAUDE.id)).id)
    const config = await read()
    config.mcpServers.sentry = { command: 'npx', args: ['-y', 'sentry-mcp@2'] }
    delete config.mcpServers.linear
    await writeFile(claudeJson(), JSON.stringify(config))
    f.library[0]!.toolsOff = []
    await f.terminal.sync()
    const after = await read()
    expect(after.mcpServers.sentry).toEqual({ command: 'npx', args: ['-y', 'sentry-mcp@2'] })
    expect(after.mcpServers.linear).toBeUndefined()
    expect((await f.terminal.drifts(CLAUDE.id)).map(({ name, kind }) => [name, kind])).toEqual([
      ['sentry', 'changed'],
      ['linear', 'removed'],
    ])
    await f.terminal.resolve(CLAUDE.id, { sentry: 'file', linear: 'kettu' })
    const resolved = await read()
    expect(resolved.mcpServers.sentry).toEqual({ command: 'npx', args: ['-y', 'sentry-mcp@2'] })
    expect(resolved.mcpServers.linear.command).toBe(BRIDGE)
    expect(await f.terminal.drifts(CLAUDE.id)).toEqual([])
  })

  it('puts the original entries back as they were when turned off', async () => {
    await f.terminal.turnOn(CLAUDE.id, (await f.terminal.plan(CLAUDE.id)).id)
    const off = await f.terminal.offPlan(CLAUDE.id)
    expect(off.back.map(({ name }) => name)).toEqual(['sentry'])
    expect(off.removed).toEqual(['linear'])
    await f.terminal.turnOff(CLAUDE.id)
    const config = await read()
    expect(config.mcpServers).toEqual({
      sentry: { command: 'npx', args: ['-y', 'sentry-mcp'], env: { SENTRY_TOKEN: SECRET } },
    })
    const settings = JSON.parse(await readFile(join(f.home, '.claude', 'settings.json'), 'utf8'))
    expect(settings.permissions?.deny ?? []).toEqual([])
    expect(f.terminal.isOn(CLAUDE.id)).toBe(false)
  })

  it('restores the copy from before the takeover, which turns it off', async () => {
    const original = await readFile(claudeJson(), 'utf8')
    await f.terminal.turnOn(CLAUDE.id, (await f.terminal.plan(CLAUDE.id)).id)
    f.library.push({ ...f.library[0]!, id: 'ctx', name: 'context7', toolsOff: [] })
    f.library.at(-1)!.spec = {
      type: 'http',
      url: 'https://ctx.example/mcp',
      transport: 'streamable-http',
      headers: [],
    }
    await f.terminal.sync()
    expect((await read()).mcpServers.context7).toBeDefined()
    const backups = await f.terminal.backups(CLAUDE.id)
    expect(backups.map(({ reason }) => reason)).toEqual(['update', 'takeover'])
    await f.terminal.restore(CLAUDE.id, backups.at(-1)!.id)
    expect(await readFile(claudeJson(), 'utf8')).toBe(original)
    expect(f.terminal.isOn(CLAUDE.id)).toBe(false)
  })
})

describe('a takeover of Codex', () => {
  it('writes TOML tables with the tools turned off, keeping the comments', async () => {
    const codex: TerminalOwner = { id: 'codex', harness: 'codex', app: null, folder: null }
    const f = await fixture(codex, { path: 'config.toml', layout: 'codex', agentId: codex.id })
    try {
      const file = join(f.home, 'config.toml')
      await writeFile(
        file,
        '# mine\nmodel = "gpt"\n\n[mcp_servers.notes]\ncommand = "npx"\nargs = ["-y", "notes-mcp"]\n',
      )
      f.library.push({
        id: 'manual:notes',
        name: 'notes',
        title: 'notes',
        source: 'manual',
        version: null,
        spec: { type: 'stdio', command: 'npx', args: ['-y', 'notes-mcp'], env: [] },
        agents: 'all',
        on: true,
        toolsOff: ['wipe'],
      })
      await f.terminal.turnOn(codex.id, (await f.terminal.plan(codex.id)).id)
      expect(f.imports).toBe(0)
      const text = await readFile(file, 'utf8')
      expect(text).toContain('# mine')
      expect(parseToml(text)).toMatchObject({
        model: 'gpt',
        mcp_servers: {
          notes: {
            command: BRIDGE,
            args: ['mcp', 'connect', 'notes', '--agent', 'codex'],
            env_vars: ['KETTU_MCP_SESSION'],
            disabled_tools: ['wipe'],
          },
        },
      })
      await f.terminal.turnOff(codex.id)
      expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({
        mcp_servers: { notes: { command: 'npx', args: ['-y', 'notes-mcp'] } },
      })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('flags Codex remote http_headers secrets on takeover and restores http_headers when turned off', async () => {
    const codex: TerminalOwner = { id: 'codex', harness: 'codex', app: null, folder: null }
    const f = await fixture(codex, { path: 'config.toml', layout: 'codex', agentId: codex.id })
    try {
      const file = join(f.home, 'config.toml')
      await writeFile(
        file,
        [
          '# mine',
          'model = "gpt"',
          '',
          '[mcp_servers.remote]',
          'url = "https://mcp.example.com/mcp"',
          'bearer_token_env_var = "REMOTE_TOKEN"',
          '',
          '[mcp_servers.remote.http_headers]',
          '"X-Api-Key" = "' + SECRET + '"',
          '',
          '[mcp_servers.remote.env_http_headers]',
          '"X-Env" = "ENV_KEY"',
          '',
        ].join('\n'),
      )

      const plan = await f.terminal.plan(codex.id)
      expect(plan.imports).toEqual([
        { name: 'remote', command: 'https://mcp.example.com/mcp', keys: true },
      ])
      expect(JSON.stringify(plan)).not.toContain(SECRET)

      await f.terminal.turnOn(codex.id, plan.id)
      expect(f.imports).toBe(1)
      expect(f.library[0]?.spec).toMatchObject({
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: [
          { name: 'X-Api-Key', input: true, secret: true, required: true },
          { name: 'X-Env', value: '${ENV_KEY}' },
          { name: 'Authorization', value: 'Bearer ${REMOTE_TOKEN}' },
        ],
      })

      const taken = await readFile(file, 'utf8')
      expect(taken).toContain('# mine')
      expect(taken).not.toContain(SECRET)
      expect(parseToml(taken)).toMatchObject({
        model: 'gpt',
        mcp_servers: {
          remote: {
            command: BRIDGE,
            args: ['mcp', 'connect', 'remote', '--agent', 'codex'],
            env_vars: ['KETTU_MCP_SESSION'],
          },
        },
      })

      const off = await f.terminal.offPlan(codex.id)
      expect(off.back).toEqual([
        { name: 'remote', command: 'https://mcp.example.com/mcp', keys: true },
      ])

      await f.terminal.turnOff(codex.id)
      const restored = await readFile(file, 'utf8')
      expect(restored).toContain('# mine')
      expect(parseToml(restored)).toEqual({
        model: 'gpt',
        mcp_servers: {
          remote: {
            url: 'https://mcp.example.com/mcp',
            bearer_token_env_var: 'REMOTE_TOKEN',
            http_headers: { 'X-Api-Key': SECRET },
            env_http_headers: { 'X-Env': 'ENV_KEY' },
          },
        },
      })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
})

const server = (id: string, agents: MarketServer['agents'], command: string): MarketServer => ({
  id,
  name: id,
  title: id,
  source: 'manual',
  version: null,
  spec: { type: 'stdio', command, args: [], env: [] },
  agents,
  on: true,
})

describe('a takeover of an app', () => {
  const VSCODE: TerminalOwner = { id: 'app:vscode', harness: null, app: 'vscode', folder: null }
  const ZED: TerminalOwner = { id: 'app:zed', harness: null, app: 'zed', folder: null }

  it("writes VS Code's servers in its JSONC file, keeping its tabs, comments and inputs", async () => {
    const f = await fixture(VSCODE, { path: 'mcp.json', layout: 'vscode', app: 'VS Code' })
    try {
      const file = join(f.home, 'mcp.json')
      await writeFile(
        file,
        '{\n\t// mine\n\t"servers": {\n\t\t"notes": { "command": "npx", "args": ["-y", "notes-mcp"], "env": { "K": "' +
          SECRET +
          '" } },\n\t\t"only": { "command": "only-mcp" }\n\t},\n\t"inputs": []\n}\n',
      )
      f.library.push(server('shared', 'all', 'shared-mcp'))
      f.library.push(server('only', ['codex' as AgentId], 'only-mcp'))
      const plan = await f.terminal.plan(VSCODE.id)
      // A server kept for some agents is not the app's: its own entry stays as it is.
      expect(plan.entries).toEqual([
        { name: 'notes', replaces: true },
        { name: 'shared', replaces: false },
      ])
      await f.terminal.turnOn(VSCODE.id, plan.id)
      const notes = f.library.find((item) => item.name === 'notes')
      expect(notes?.agents).toBe('all')
      const text = await readFile(file, 'utf8')
      expect(text).toContain('\t// mine')
      expect(text).not.toContain(SECRET)
      const config = parseJsonc(text)
      expect(config.inputs).toEqual([])
      expect(config.servers.only).toEqual({ command: 'only-mcp' })
      expect(config.servers.notes).toEqual({
        type: 'stdio',
        command: BRIDGE,
        args: ['mcp', 'connect', 'notes', '--agent', 'app:vscode'],
      })
      expect(config.servers.shared.args).toContain('app:vscode')
      await f.terminal.turnOff(VSCODE.id)
      const back = parseJsonc(await readFile(file, 'utf8'))
      expect(back.servers.notes.env.K).toBe(SECRET)
      expect(Object.keys(back.servers)).toEqual(['notes', 'only'])
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it('puts its own entry back, key and all, once the server stops going to every agent', async () => {
    const f = await fixture(VSCODE, { path: 'mcp.json', layout: 'vscode', app: 'VS Code' })
    try {
      const file = join(f.home, 'mcp.json')
      await writeFile(
        file,
        '{\n\t"servers": {\n\t\t"notes": { "command": "npx", "args": ["-y", "notes-mcp"], "env": { "K": "' +
          SECRET +
          '" } }\n\t}\n}\n',
      )
      f.library.push(server('shared', 'all', 'shared-mcp'))
      await f.terminal.turnOn(VSCODE.id, (await f.terminal.plan(VSCODE.id)).id)
      expect(parseJsonc(await readFile(file, 'utf8')).servers.notes.args).toContain('app:vscode')
      for (const item of f.library) item.agents = ['codex' as AgentId]
      await f.terminal.sync()
      const config = parseJsonc(await readFile(file, 'utf8'))
      expect(config.servers).toEqual({
        notes: { command: 'npx', args: ['-y', 'notes-mcp'], env: { K: SECRET } },
      })
      expect(f.terminal.written(VSCODE.id)).toEqual([])
      expect(f.terminal.isOn(VSCODE.id)).toBe(true)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })

  it("writes Zed's context servers beside its other settings", async () => {
    const f = await fixture(ZED, { path: 'settings.json', layout: 'zed', app: 'Zed' })
    try {
      const file = join(f.home, 'settings.json')
      await writeFile(file, '// Zed settings\n{\n  "theme": "One Dark",\n  "vim_mode": true,\n}\n')
      f.library.push(server('shared', 'all', 'shared-mcp'))
      await f.terminal.turnOn(ZED.id, (await f.terminal.plan(ZED.id)).id)
      const text = await readFile(file, 'utf8')
      expect(text).toContain('// Zed settings')
      expect(parseJsonc(text, [], { allowTrailingComma: true })).toEqual({
        theme: 'One Dark',
        vim_mode: true,
        context_servers: {
          shared: {
            command: BRIDGE,
            args: ['mcp', 'connect', 'shared', '--agent', 'app:zed'],
            env: {},
          },
        },
      })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
})

describe('a server that stops going to a takeover', () => {
  it("puts the agent's own entry back as it was, and keeps the takeover on", async () => {
    const codex: TerminalOwner = { id: 'codex', harness: 'codex', app: null, folder: null }
    const f = await fixture(codex, { path: 'config.toml', layout: 'codex', agentId: codex.id })
    try {
      const file = join(f.home, 'config.toml')
      const own =
        '[mcp_servers.notes]\ncommand = "npx"\nargs = ["-y", "notes-mcp"]\nenv = { K = "' +
        SECRET +
        '" }\n'
      await writeFile(file, '# mine\n' + own)
      await f.terminal.turnOn(codex.id, (await f.terminal.plan(codex.id)).id)
      const notes = f.library.find((item) => item.name === 'notes')!
      notes.agents = ['claude-code' as AgentId]
      await f.terminal.sync()
      const text = await readFile(file, 'utf8')
      expect(text).toContain('# mine')
      expect(parseToml(text)).toEqual({
        mcp_servers: { notes: { command: 'npx', args: ['-y', 'notes-mcp'], env: { K: SECRET } } },
      })
      expect(f.terminal.written(codex.id)).toEqual([])
      // Given to it again, it goes through Kettu again, the entry it had replaced once more.
      notes.agents = 'all'
      await f.terminal.sync()
      expect(parseToml(await readFile(file, 'utf8'))).toMatchObject({
        mcp_servers: { notes: { command: BRIDGE } },
      })
      await f.terminal.turnOff(codex.id)
      expect(parseToml(await readFile(file, 'utf8'))).toEqual({
        mcp_servers: { notes: { command: 'npx', args: ['-y', 'notes-mcp'], env: { K: SECRET } } },
      })
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
})

describe('the connect file', () => {
  it('is readable by its owner alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kettu-connect-'))
    try {
      await writeConnectFile(root, 'http://127.0.0.1:4100', 'key-1')
      const file = join(root, CONNECT_FILE)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect(await readFile(file, 'utf8')).toBe(
        'kettu-mcp-bridge 1\nurl=http://127.0.0.1:4100\nkey=key-1\n',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
