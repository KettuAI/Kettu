import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import { configLocations, readAgentDetails, type ConfigLocation } from './agent-details'

type Vars = Record<string, string | undefined>

function locations(agentId: AgentId, vars: Vars, home: string, platform: Platform) {
  return configLocations(agentId, (name) => vars[name], home, platform)
}

/** The first candidate of each entry, with the variable that set it. */
function summary(list: ConfigLocation[]) {
  return list.map(({ id, candidates, env }) => ({ id, candidates, env }))
}

describe('configLocations', () => {
  it('puts Claude Code in ~/.claude, or where CLAUDE_CONFIG_DIR says', () => {
    expect(summary(locations('claude-code', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.claude'], env: null },
      { id: 'settings', candidates: ['/home/me/.claude/settings.json'], env: null },
      { id: 'instructions', candidates: ['/home/me/.claude/CLAUDE.md'], env: null },
    ])
    expect(
      summary(locations('claude-code', { CLAUDE_CONFIG_DIR: '/srv/claude' }, '/home/me', 'darwin')),
    ).toEqual([
      { id: 'folder', candidates: ['/srv/claude'], env: 'CLAUDE_CONFIG_DIR' },
      { id: 'settings', candidates: ['/srv/claude/settings.json'], env: null },
      { id: 'instructions', candidates: ['/srv/claude/CLAUDE.md'], env: null },
    ])
  })

  it('puts Codex in ~/.codex, or where CODEX_HOME says', () => {
    expect(summary(locations('codex', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.codex'], env: null },
      { id: 'settings', candidates: ['/home/me/.codex/config.toml'], env: null },
      { id: 'instructions', candidates: ['/home/me/.codex/AGENTS.md'], env: null },
    ])
    expect(summary(locations('codex', { CODEX_HOME: '/srv/codex' }, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/srv/codex'], env: 'CODEX_HOME' },
      { id: 'settings', candidates: ['/srv/codex/config.toml'], env: null },
      { id: 'instructions', candidates: ['/srv/codex/AGENTS.md'], env: null },
    ])
  })

  it('puts OpenCode in the XDG config folder, with two names for its settings', () => {
    expect(summary(locations('opencode', {}, '/home/me', 'darwin'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.config/opencode'], env: null },
      {
        id: 'settings',
        candidates: [
          '/home/me/.config/opencode/opencode.json',
          '/home/me/.config/opencode/opencode.jsonc',
        ],
        env: null,
      },
      { id: 'instructions', candidates: ['/home/me/.config/opencode/AGENTS.md'], env: null },
    ])
    expect(
      summary(locations('opencode', { XDG_CONFIG_HOME: '/xdg' }, '/home/me', 'linux')),
    ).toEqual([
      { id: 'folder', candidates: ['/xdg/opencode'], env: 'XDG_CONFIG_HOME' },
      {
        id: 'settings',
        candidates: ['/xdg/opencode/opencode.json', '/xdg/opencode/opencode.jsonc'],
        env: null,
      },
      { id: 'instructions', candidates: ['/xdg/opencode/AGENTS.md'], env: null },
    ])
  })

  it('lets OPENCODE_CONFIG name the settings file alone', () => {
    const list = locations(
      'opencode',
      { OPENCODE_CONFIG: '/etc/oc/custom.json' },
      '/home/me',
      'linux',
    )
    expect(summary(list)[1]).toEqual({
      id: 'settings',
      candidates: ['/etc/oc/custom.json'],
      env: 'OPENCODE_CONFIG',
    })
    expect(summary(list)[0]).toMatchObject({ candidates: ['/home/me/.config/opencode'], env: null })
  })

  it('puts Claude Code and Codex in the folder picked in Settings, over their variables', () => {
    const claude = configLocations(
      'claude-code',
      (name) => ({ CLAUDE_CONFIG_DIR: '/picked' })[name],
      '/home/me',
      'linux',
      '/picked',
    )
    expect(claude[0]).toEqual({
      id: 'folder',
      candidates: ['/picked'],
      env: null,
      chosen: true,
    })
    expect(claude[1]).toMatchObject({ candidates: ['/picked/settings.json'], env: null })
    const codex = configLocations('codex', () => '/srv/codex', '/home/me', 'linux', '/picked')
    expect(summary(codex)).toEqual([
      { id: 'folder', candidates: ['/picked'], env: null },
      { id: 'settings', candidates: ['/picked/config.toml'], env: null },
      { id: 'instructions', candidates: ['/picked/AGENTS.md'], env: null },
    ])
  })

  it('puts Pi in ~/.pi/agent, or where PI_CODING_AGENT_DIR says', () => {
    expect(summary(locations('pi', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.pi/agent'], env: null },
      { id: 'settings', candidates: ['/home/me/.pi/agent/settings.json'], env: null },
      {
        id: 'instructions',
        candidates: [
          '/home/me/.pi/agent/AGENTS.override.md',
          '/home/me/.pi/agent/AGENTS.md',
          '/home/me/.pi/agent/CLAUDE.md',
        ],
        env: null,
      },
    ])
    expect(
      summary(locations('pi', { PI_CODING_AGENT_DIR: '/srv/pi' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/pi'], env: 'PI_CODING_AGENT_DIR' })
  })

  it('shows the first instructions file Pi finds, and AGENTS.md when none does', async () => {
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overbench-pi-details-')))
    try {
      const folder = path.join(home, '.pi', 'agent')
      await mkdir(folder, { recursive: true })
      await writeFile(path.join(folder, 'CLAUDE.md'), '# rules')
      expect(await detailsOf('pi', home)).toMatchObject({
        path: path.join(folder, 'CLAUDE.md'),
        exists: true,
      })
      await writeFile(path.join(folder, 'AGENTS.md'), '# rules')
      expect(await detailsOf('pi', home)).toMatchObject({
        path: path.join(folder, 'AGENTS.md'),
        exists: true,
      })
      await rm(path.join(folder, 'AGENTS.md'))
      await rm(path.join(folder, 'CLAUDE.md'))
      expect(await detailsOf('pi', home)).toMatchObject({
        path: path.join(folder, 'AGENTS.md'),
        exists: false,
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  /** Pi's instructions row in `home`. */
  async function detailsOf(agentId: AgentId, home: string) {
    const { config } = await readAgentDetails(agentId, {
      getEnv: () => undefined,
      home,
      platform: process.platform as Platform,
      adapterDir: null,
      log: () => {},
    })
    return config.find((item) => item.id === 'instructions')!
  }

  it('has nothing to show for the fake agent', () => {
    expect(locations('fake-agent', { CLAUDE_CONFIG_DIR: '/x' }, '/home/me', 'linux')).toEqual([])
  })

  it('joins with backslashes on Windows', () => {
    expect(summary(locations('claude-code', {}, 'C:\\Users\\me', 'win32'))).toEqual([
      { id: 'folder', candidates: ['C:\\Users\\me\\.claude'], env: null },
      { id: 'settings', candidates: ['C:\\Users\\me\\.claude\\settings.json'], env: null },
      { id: 'instructions', candidates: ['C:\\Users\\me\\.claude\\CLAUDE.md'], env: null },
    ])
    expect(
      summary(locations('codex', { CODEX_HOME: 'D:\\tools\\codex' }, 'C:\\Users\\me', 'win32')),
    ).toEqual([
      { id: 'folder', candidates: ['D:\\tools\\codex'], env: 'CODEX_HOME' },
      { id: 'settings', candidates: ['D:\\tools\\codex\\config.toml'], env: null },
      { id: 'instructions', candidates: ['D:\\tools\\codex\\AGENTS.md'], env: null },
    ])
    expect(summary(locations('opencode', {}, 'C:\\Users\\me', 'win32'))[0]).toEqual({
      id: 'folder',
      candidates: ['C:\\Users\\me\\.config\\opencode'],
      env: null,
    })
  })

  it('ignores blank variables and resolves relative ones from the home directory', () => {
    const blank = locations('claude-code', { CLAUDE_CONFIG_DIR: '  ' }, '/home/me', 'linux')
    expect(summary(blank)[0]).toEqual({
      id: 'folder',
      candidates: ['/home/me/.claude'],
      env: null,
    })
    const empty = locations('codex', { CODEX_HOME: '' }, '/home/me', 'linux')
    expect(summary(empty)[0]).toMatchObject({ candidates: ['/home/me/.codex'], env: null })
    const relative = locations('codex', { CODEX_HOME: 'dotfiles/codex/' }, '/home/me', 'linux')
    expect(summary(relative)[0]).toEqual({
      id: 'folder',
      candidates: ['/home/me/dotfiles/codex'],
      env: 'CODEX_HOME',
    })
  })
})

describe('readAgentDetails', () => {
  const platform = process.platform as Platform
  let tmp: string
  let adaptersDir: string
  let counter = 0

  beforeAll(async () => {
    tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overbench-details-')))
    adaptersDir = path.join(tmp, 'agents')
  })

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  /** A fresh home directory, so one test's files never leak into another. */
  async function newHome(): Promise<string> {
    const home = path.join(tmp, `home-${counter++}`)
    await mkdir(home, { recursive: true })
    return home
  }

  async function put(file: string, content = ''): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }

  function read(
    agentId: AgentId,
    home: string,
    options: { vars?: Vars; adapterVersion?: string | null; chosen?: string } = {},
  ) {
    const logs: { level: string; message: string }[] = []
    const details = readAgentDetails(agentId, {
      getEnv: (name) => options.vars?.[name],
      home,
      platform,
      chosen: options.chosen ?? null,
      adapterDir: options.adapterVersion
        ? path.join(adaptersDir, agentId, options.adapterVersion)
        : null,
      log: (level, message) => logs.push({ level, message }),
    })
    return { details, logs }
  }

  it('says which places exist, with a folder that must be a directory', async () => {
    const home = await newHome()
    await put(path.join(home, '.claude', 'settings.json'), '{}')
    const { details, logs } = read('claude-code', home)
    expect(await details).toEqual({
      cliVersion: null,
      config: [
        { id: 'folder', path: path.join(home, '.claude'), exists: true, env: null, chosen: false },
        {
          id: 'settings',
          path: path.join(home, '.claude', 'settings.json'),
          exists: true,
          env: null,
          chosen: false,
        },
        {
          id: 'instructions',
          path: path.join(home, '.claude', 'CLAUDE.md'),
          exists: false,
          env: null,
          chosen: false,
        },
      ],
    })
    expect(logs).toEqual([])
  })

  it('reports everything missing for an agent that never ran', async () => {
    const home = await newHome()
    const { details, logs } = read('codex', home)
    expect((await details).config.map((item) => item.exists)).toEqual([false, false, false])
    expect(logs).toEqual([])
  })

  it('does not take a file for a folder, or a folder for a file', async () => {
    const home = await newHome()
    await put(path.join(home, '.codex'), 'not a folder')
    const first = await read('codex', home).details
    expect(first.config.map((item) => item.exists)).toEqual([false, false, false])

    const other = await newHome()
    await mkdir(path.join(other, '.codex', 'config.toml'), { recursive: true })
    const second = await read('codex', other).details
    expect(second.config.map((item) => item.exists)).toEqual([true, false, false])
  })

  it('follows the variables that move a folder', async () => {
    const home = await newHome()
    const moved = path.join(home, 'elsewhere')
    await put(path.join(moved, 'CLAUDE.md'), '# rules')
    const { config } = await read('claude-code', home, { vars: { CLAUDE_CONFIG_DIR: moved } })
      .details
    expect(config).toEqual([
      { id: 'folder', path: moved, exists: true, env: 'CLAUDE_CONFIG_DIR', chosen: false },
      {
        id: 'settings',
        path: path.join(moved, 'settings.json'),
        exists: false,
        env: null,
        chosen: false,
      },
      {
        id: 'instructions',
        path: path.join(moved, 'CLAUDE.md'),
        exists: true,
        env: null,
        chosen: false,
      },
    ])
  })

  it('marks the folder picked in Settings as chosen', async () => {
    const home = await newHome()
    const picked = path.join(home, 'gateway')
    await mkdir(picked)
    const { details } = read('claude-code', home, {
      vars: { CLAUDE_CONFIG_DIR: picked },
      chosen: picked,
    })
    expect((await details).config[0]).toEqual({
      id: 'folder',
      path: picked,
      exists: true,
      env: null,
      chosen: true,
    })
  })

  describe('OpenCode settings', () => {
    it('shows opencode.json when neither file exists', async () => {
      const home = await newHome()
      const { config } = await read('opencode', home).details
      expect(config[1]).toEqual({
        id: 'settings',
        path: path.join(home, '.config', 'opencode', 'opencode.json'),
        exists: false,
        env: null,
        chosen: false,
      })
    })

    it('falls back to opencode.jsonc when only that exists', async () => {
      const home = await newHome()
      const jsonc = path.join(home, '.config', 'opencode', 'opencode.jsonc')
      await put(jsonc, '{}')
      const { config } = await read('opencode', home).details
      expect(config[1]).toEqual({
        id: 'settings',
        path: jsonc,
        exists: true,
        env: null,
        chosen: false,
      })
    })

    it('prefers opencode.json when both exist', async () => {
      const home = await newHome()
      const folder = path.join(home, '.config', 'opencode')
      await put(path.join(folder, 'opencode.json'), '{}')
      await put(path.join(folder, 'opencode.jsonc'), '{}')
      const { config } = await read('opencode', home).details
      expect(config[1]).toMatchObject({ path: path.join(folder, 'opencode.json'), exists: true })
    })

    it('uses OPENCODE_CONFIG alone when set', async () => {
      const home = await newHome()
      const folder = path.join(home, '.config', 'opencode')
      await put(path.join(folder, 'opencode.json'), '{}')
      const custom = path.join(home, 'custom', 'oc.json')
      const { config } = await read('opencode', home, { vars: { OPENCODE_CONFIG: custom } }).details
      expect(config[1]).toEqual({
        id: 'settings',
        path: custom,
        exists: false,
        env: 'OPENCODE_CONFIG',
        chosen: false,
      })
      expect(config[0]).toMatchObject({ path: folder, exists: true, env: null, chosen: false })
    })
  })

  it('reports an unreadable place as missing and logs why', async (context) => {
    if (platform === 'win32' || process.getuid?.() === 0) context.skip()
    const home = await newHome()
    const folder = path.join(home, '.claude')
    await put(path.join(folder, 'settings.json'), '{}')
    await chmod(folder, 0o000)
    try {
      const { details, logs } = read('claude-code', home)
      const { config } = await details
      expect(config.map((item) => item.exists)).toEqual([true, false, false])
      expect(logs.map((entry) => entry.level)).toEqual(['warn', 'warn'])
      expect(logs[0]?.message).toContain(path.join(folder, 'settings.json'))
      expect(logs[1]?.message).toContain(path.join(folder, 'CLAUDE.md'))
    } finally {
      await chmod(folder, 0o755)
    }
  })

  describe('cliVersion', () => {
    const packageFile = (agentId: string, version: string, pkg: string) =>
      path.join(adaptersDir, agentId, version, 'node_modules', pkg, 'package.json')

    it('reads the Claude Code version the SDK bundles', async () => {
      const home = await newHome()
      await put(
        packageFile('claude-code', '1.0.0', '@anthropic-ai/claude-agent-sdk'),
        JSON.stringify({ version: '0.3.303', claudeCodeVersion: '2.1.303' }),
      )
      const { details } = read('claude-code', home, { adapterVersion: '1.0.0' })
      expect((await details).cliVersion).toBe('2.1.303')
    })

    it('reads the Codex version of its bundled CLI', async () => {
      const home = await newHome()
      await put(
        packageFile('codex', '2.0.0', '@openai/codex'),
        JSON.stringify({ name: '@openai/codex', version: '0.160.1' }),
      )
      const { details } = read('codex', home, { adapterVersion: '2.0.0' })
      expect((await details).cliVersion).toBe('0.160.1')
    })

    it('is null without a warning when the adapter is not installed', async () => {
      const home = await newHome()
      const { details, logs } = read('claude-code', home, { adapterVersion: '9.9.9' })
      expect((await details).cliVersion).toBeNull()
      expect(logs).toEqual([])
    })

    it('is null with a warning when the file is malformed or lacks the field', async () => {
      const home = await newHome()
      const claude = packageFile('claude-code', '3.0.0', '@anthropic-ai/claude-agent-sdk')
      await put(claude, '{ not json')
      const broken = read('claude-code', home, { adapterVersion: '3.0.0' })
      expect((await broken.details).cliVersion).toBeNull()
      expect(broken.logs).toHaveLength(1)
      expect(broken.logs[0]).toMatchObject({ level: 'warn' })
      expect(broken.logs[0]?.message).toContain(claude)

      await put(claude, JSON.stringify({ version: '0.3.303' }))
      const missing = read('claude-code', home, { adapterVersion: '3.0.0' })
      expect((await missing.details).cliVersion).toBeNull()
      expect(missing.logs).toHaveLength(1)

      await put(claude, JSON.stringify({ claudeCodeVersion: 2 }))
      expect(
        (await read('claude-code', home, { adapterVersion: '3.0.0' }).details).cliVersion,
      ).toBeNull()

      await put(claude, 'null')
      expect(
        (await read('claude-code', home, { adapterVersion: '3.0.0' }).details).cliVersion,
      ).toBeNull()
    })

    it('is null for agents without a bundled CLI', async () => {
      const home = await newHome()
      expect((await read('opencode', home).details).cliVersion).toBeNull()
      expect(await read('fake-agent', home).details).toEqual({ cliVersion: null, config: [] })
    })
  })
})
