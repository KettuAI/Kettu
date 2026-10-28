import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import {
  configLocations,
  mcpLocation,
  readAgentDetails,
  type ConfigLocation,
} from './agent-details'

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

  it('has nothing to show for the fake agent, DeepAgents or Agoragentic', () => {
    expect(locations('fake-agent', { CLAUDE_CONFIG_DIR: '/x' }, '/home/me', 'linux')).toEqual([])
    expect(locations('deepagents', {}, '/home/me', 'linux')).toEqual([])
    expect(locations('agoragentic', {}, '/home/me', 'linux')).toEqual([])
  })

  it('puts Auggie in ~/.augment, with its settings and prompt additions', () => {
    expect(summary(locations('auggie', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.augment'], env: null },
      { id: 'settings', candidates: ['/home/me/.augment/settings.json'], env: null },
      { id: 'instructions', candidates: ['/home/me/.augment/APPEND_SYSTEM.md'], env: null },
    ])
  })

  it('puts Codebuddy in ~/.codebuddy, or where CODEBUDDY_CONFIG_DIR says', () => {
    expect(summary(locations('codebuddy', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.codebuddy'], env: null },
      { id: 'settings', candidates: ['/home/me/.codebuddy/settings.json'], env: null },
      { id: 'instructions', candidates: ['/home/me/.codebuddy/CODEBUDDY.md'], env: null },
    ])
    expect(
      summary(locations('codebuddy', { CODEBUDDY_CONFIG_DIR: '/srv/cb' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/cb'], env: 'CODEBUDDY_CONFIG_DIR' })
  })

  it('puts DimCode in its v2 folder, or where DIMCODE_HOME says', () => {
    expect(summary(locations('dimcode', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.dimcode/v2'], env: null },
    ])
    expect(
      summary(locations('dimcode', { DIMCODE_HOME: '/srv/dim' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/dim'], env: 'DIMCODE_HOME' })
  })

  it('puts Dirac in ~/.dirac/data, or where DIRAC_DIR says', () => {
    expect(summary(locations('dirac', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.dirac/data'], env: null },
    ])
    expect(
      summary(locations('dirac', { DIRAC_DIR: '/srv/dirac' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/dirac'], env: 'DIRAC_DIR' })
  })

  it('puts GLM Agent in the XDG config folder, with its credentials', () => {
    expect(summary(locations('glm', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.config/glm-acp-agent'], env: null },
      {
        id: 'settings',
        candidates: ['/home/me/.config/glm-acp-agent/credentials.json'],
        env: null,
      },
    ])
    expect(summary(locations('glm', { XDG_CONFIG_HOME: '/xdg' }, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/xdg/glm-acp-agent'], env: 'XDG_CONFIG_HOME' },
      { id: 'settings', candidates: ['/xdg/glm-acp-agent/credentials.json'], env: null },
    ])
  })

  it('puts Nova in ~/.nova, with its legacy ~/.compass folder after it', () => {
    expect(summary(locations('nova', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.nova', '/home/me/.compass'], env: null },
      {
        id: 'settings',
        candidates: ['/home/me/.nova/config.json', '/home/me/.compass/config.json'],
        env: null,
      },
      {
        id: 'instructions',
        candidates: [
          '/home/me/.nova/AGENTS.md',
          '/home/me/.nova/NOVA.md',
          '/home/me/.compass/AGENTS.md',
          '/home/me/.compass/NOVA.md',
        ],
        env: null,
      },
    ])
  })

  it('puts Qoder CLI in ~/.qoder, or where QODER_CONFIG_DIR says', () => {
    expect(summary(locations('qoder', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.qoder'], env: null },
      { id: 'settings', candidates: ['/home/me/.qoder/settings.json'], env: null },
      { id: 'instructions', candidates: ['/home/me/.qoder/AGENTS.md'], env: null },
    ])
    expect(
      summary(locations('qoder', { QODER_CONFIG_DIR: '/srv/qoder' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/qoder'], env: 'QODER_CONFIG_DIR' })
  })

  it('puts siGit in ~/.config/sigit, or where SIGIT_CONFIG_DIR says', () => {
    expect(summary(locations('sigit', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.config/sigit'], env: null },
      { id: 'settings', candidates: ['/home/me/.config/sigit/settings.toml'], env: null },
    ])
    expect(
      summary(locations('sigit', { SIGIT_CONFIG_DIR: '/srv/sigit' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/sigit'], env: 'SIGIT_CONFIG_DIR' })
  })

  it('puts Autohand Code in ~/.autohand, with any config format it accepts', () => {
    expect(summary(locations('autohand', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.autohand'], env: null },
      {
        id: 'settings',
        candidates: [
          '/home/me/.autohand/config.toml',
          '/home/me/.autohand/config.yaml',
          '/home/me/.autohand/config.yml',
          '/home/me/.autohand/config.json',
        ],
        env: null,
      },
    ])
    expect(
      summary(locations('autohand', { AUTOHAND_HOME: '/srv/ah' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/ah'], env: 'AUTOHAND_HOME' })
  })

  it('puts Gemini in .gemini under GEMINI_CLI_HOME, or in ~/.gemini', () => {
    expect(summary(locations('gemini', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.gemini'], env: null },
      { id: 'settings', candidates: ['/home/me/.gemini/settings.json'], env: null },
      { id: 'instructions', candidates: ['/home/me/.gemini/GEMINI.md'], env: null },
    ])
    expect(
      summary(locations('gemini', { GEMINI_CLI_HOME: '/srv/home' }, '/home/me', 'linux')),
    ).toEqual([
      { id: 'folder', candidates: ['/srv/home/.gemini'], env: 'GEMINI_CLI_HOME' },
      { id: 'settings', candidates: ['/srv/home/.gemini/settings.json'], env: null },
      { id: 'instructions', candidates: ['/srv/home/.gemini/GEMINI.md'], env: null },
    ])
  })

  it('puts GitHub Copilot in ~/.copilot, or where COPILOT_HOME says', () => {
    expect(summary(locations('copilot', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.copilot'], env: null },
      { id: 'settings', candidates: ['/home/me/.copilot/config.json'], env: null },
      { id: 'instructions', candidates: ['/home/me/.copilot/copilot-instructions.md'], env: null },
    ])
    expect(
      summary(locations('copilot', { COPILOT_HOME: '/srv/copilot' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/copilot'], env: 'COPILOT_HOME' })
  })

  it('puts Qwen Code in ~/.qwen with its settings and QWEN.md', () => {
    expect(summary(locations('qwen', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.qwen'], env: null },
      { id: 'settings', candidates: ['/home/me/.qwen/settings.json'], env: null },
      { id: 'instructions', candidates: ['/home/me/.qwen/QWEN.md'], env: null },
    ])
  })

  it('puts Grok in ~/.grok, or where GROK_HOME says', () => {
    expect(summary(locations('grok', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.grok'], env: null },
      { id: 'settings', candidates: ['/home/me/.grok/config.toml'], env: null },
      { id: 'instructions', candidates: ['/home/me/.grok/AGENTS.md'], env: null },
    ])
    expect(summary(locations('grok', { GROK_HOME: '/srv/grok' }, '/home/me', 'linux'))[0]).toEqual({
      id: 'folder',
      candidates: ['/srv/grok'],
      env: 'GROK_HOME',
    })
  })

  it('puts Cline in ~/.cline, or where CLINE_DIR says, with its global rules', () => {
    expect(summary(locations('cline', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.cline'], env: null },
      {
        id: 'settings',
        candidates: ['/home/me/.cline/data/settings/global-settings.json'],
        env: null,
      },
      { id: 'instructions', candidates: ['/home/me/.agents/AGENTS.md'], env: null },
    ])
    expect(
      summary(locations('cline', { CLINE_DIR: '/srv/cline' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/cline'], env: 'CLINE_DIR' })
  })

  it('puts Factory Droid in ~/.factory with its settings and AGENTS.md', () => {
    expect(summary(locations('droid', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.factory'], env: null },
      { id: 'settings', candidates: ['/home/me/.factory/settings.json'], env: null },
      { id: 'instructions', candidates: ['/home/me/.factory/AGENTS.md'], env: null },
    ])
  })

  it('puts MiniMax Code in ~/.minimax, or where MINIMAX_DATA_DIR says', () => {
    expect(summary(locations('minimax', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.minimax'], env: null },
      { id: 'settings', candidates: ['/home/me/.minimax/config.yaml'], env: null },
    ])
    expect(
      summary(locations('minimax', { MINIMAX_DATA_DIR: '/srv/minimax' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/minimax'], env: 'MINIMAX_DATA_DIR' })
  })

  it('names no configuration folder for agents whose docs give none', () => {
    for (const agent of ['bob', 'harn', 'kimchi'] as const) {
      expect(locations(agent, {}, '/home/me', 'linux')).toEqual([])
    }
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

describe('mcpLocation', () => {
  const platform = process.platform as Platform
  let home: string

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'overbench-mcp-location-')))
  })

  afterAll(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const locate = (agentId: AgentId, vars: Vars, chosen: string | null = null) =>
    mcpLocation(
      agentId,
      (name) => vars[name],
      home,
      platform,
      chosen,
      () => {},
    )

  it("finds Claude Code's .claude.json in the home folder, or where its variable says", async () => {
    expect(await locate('claude-code', {})).toMatchObject({
      path: path.join(home, '.claude.json'),
      env: null,
      chosen: false,
      exists: false,
    })
    const moved = path.join(home, 'claude-config')
    await mkdir(moved, { recursive: true })
    await writeFile(path.join(moved, '.claude.json'), '{}')
    expect(await locate('claude-code', { CLAUDE_CONFIG_DIR: moved })).toEqual({
      path: path.join(moved, '.claude.json'),
      env: 'CLAUDE_CONFIG_DIR',
      chosen: false,
      exists: true,
    })
  })

  it('finds it in the folder picked in Settings, which wins over the variable', async () => {
    const picked = path.join(home, 'picked')
    await mkdir(picked, { recursive: true })
    const location = await locate('claude-code', { CLAUDE_CONFIG_DIR: '/elsewhere' }, picked)
    expect(location).toEqual({
      path: path.join(picked, '.claude.json'),
      env: null,
      chosen: true,
      exists: false,
    })
  })

  it("finds Codex's config.toml in ~/.codex, or where CODEX_HOME says", async () => {
    expect(await locate('codex', {})).toMatchObject({
      path: path.join(home, '.codex', 'config.toml'),
      env: null,
      exists: false,
    })
    const moved = path.join(home, 'codex-home')
    await mkdir(moved, { recursive: true })
    await writeFile(path.join(moved, 'config.toml'), '')
    expect(await locate('codex', { CODEX_HOME: moved })).toMatchObject({
      path: path.join(moved, 'config.toml'),
      env: 'CODEX_HOME',
      exists: true,
    })
  })

  it("finds OpenCode's settings file, its .jsonc included, or the one OPENCODE_CONFIG names", async () => {
    const dir = path.join(home, '.config', 'opencode')
    await mkdir(dir, { recursive: true })
    expect(await locate('opencode', {})).toMatchObject({
      path: path.join(dir, 'opencode.json'),
      env: null,
      exists: false,
    })
    await writeFile(path.join(dir, 'opencode.jsonc'), '{}')
    expect(await locate('opencode', {})).toMatchObject({
      path: path.join(dir, 'opencode.jsonc'),
      exists: true,
    })
    const named = path.join(home, 'custom-opencode.json')
    await writeFile(named, '{}')
    expect(await locate('opencode', { OPENCODE_CONFIG: named })).toEqual({
      path: named,
      env: 'OPENCODE_CONFIG',
      chosen: false,
      exists: true,
    })
  })

  it('has no place for an agent that keeps none', async () => {
    expect(await locate('pi', {})).toBeNull()
    expect(await locate('fake-agent', {})).toBeNull()
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

describe("the registry archive agents' config locations", () => {
  it('puts Cursor in ~/.cursor, or where CURSOR_CONFIG_DIR or XDG_CONFIG_HOME says', () => {
    expect(summary(locations('cursor', {}, '/home/me', 'darwin'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.cursor'], env: null },
      { id: 'settings', candidates: ['/home/me/.cursor/cli-config.json'], env: null },
    ])
    expect(summary(locations('cursor', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.cursor'], env: null },
      { id: 'settings', candidates: ['/home/me/.cursor/cli-config.json'], env: null },
    ])
    expect(
      summary(locations('cursor', { CURSOR_CONFIG_DIR: '/srv/cursor' }, '/home/me', 'darwin'))[0],
    ).toEqual({ id: 'folder', candidates: ['/srv/cursor'], env: 'CURSOR_CONFIG_DIR' })
    expect(
      summary(locations('cursor', { XDG_CONFIG_HOME: '/xdg' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/xdg/cursor'], env: 'XDG_CONFIG_HOME' })
    // Cursor's docs give XDG_CONFIG_HOME a folder of its own on Linux and BSD alone.
    expect(
      summary(locations('cursor', { XDG_CONFIG_HOME: '/xdg' }, '/home/me', 'darwin'))[0],
    ).toEqual({ id: 'folder', candidates: ['/home/me/.cursor'], env: null })
  })

  it('puts Kimi in ~/.kimi, or where KIMI_SHARE_DIR says', () => {
    expect(summary(locations('kimi', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.kimi'], env: null },
      { id: 'settings', candidates: ['/home/me/.kimi/config.toml'], env: null },
    ])
    expect(
      summary(locations('kimi', { KIMI_SHARE_DIR: '/srv/kimi' }, '/home/me', 'linux')),
    ).toEqual([
      { id: 'folder', candidates: ['/srv/kimi'], env: 'KIMI_SHARE_DIR' },
      { id: 'settings', candidates: ['/srv/kimi/config.toml'], env: null },
    ])
  })

  it('puts Amp in ~/.config/amp, at either settings file, with its global AGENTS.md', () => {
    expect(summary(locations('amp', {}, '/home/me', 'darwin'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.config/amp'], env: null },
      {
        id: 'settings',
        candidates: ['/home/me/.config/amp/settings.json', '/home/me/.config/amp/settings.jsonc'],
        env: null,
      },
      {
        id: 'instructions',
        candidates: ['/home/me/.config/amp/AGENTS.md', '/home/me/.config/AGENTS.md'],
        env: null,
      },
    ])
    expect(summary(locations('amp', { XDG_CONFIG_HOME: '/xdg' }, '/home/me', 'linux'))[0]).toEqual({
      id: 'folder',
      candidates: ['/xdg/amp'],
      env: 'XDG_CONFIG_HOME',
    })
  })

  it('puts goose in its config folder of the platform, or under GOOSE_PATH_ROOT', () => {
    const mac = '/home/me/Library/Application Support/Block/goose'
    expect(summary(locations('goose', {}, '/home/me', 'darwin'))).toEqual([
      { id: 'folder', candidates: [mac], env: null },
      { id: 'settings', candidates: [`${mac}/config.yaml`], env: null },
      {
        id: 'instructions',
        candidates: [`${mac}/AGENTS.md`, `${mac}/.goosehints`],
        env: null,
      },
    ])
    expect(summary(locations('goose', {}, '/home/me', 'linux'))[0]).toEqual({
      id: 'folder',
      candidates: ['/home/me/.config/goose'],
      env: null,
    })
    expect(
      summary(locations('goose', { XDG_CONFIG_HOME: '/xdg' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/xdg/goose'], env: 'XDG_CONFIG_HOME' })
    expect(
      summary(locations('goose', { GOOSE_PATH_ROOT: '/srv/goose' }, '/home/me', 'linux')),
    ).toEqual([
      { id: 'folder', candidates: ['/srv/goose/config'], env: 'GOOSE_PATH_ROOT' },
      { id: 'settings', candidates: ['/srv/goose/config/config.yaml'], env: null },
      {
        id: 'instructions',
        candidates: ['/srv/goose/config/AGENTS.md', '/srv/goose/config/.goosehints'],
        env: null,
      },
    ])
    // A relative root is ignored, as goose ignores one.
    expect(
      summary(locations('goose', { GOOSE_PATH_ROOT: 'goose' }, '/home/me', 'linux'))[0],
    ).toEqual({ id: 'folder', candidates: ['/home/me/.config/goose'], env: null })
    expect(
      summary(
        locations(
          'goose',
          { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
          'C:\\Users\\me',
          'win32',
        ),
      )[0],
    ).toEqual({
      id: 'folder',
      candidates: ['C:\\Users\\me\\AppData\\Roaming\\Block\\goose\\config'],
      env: 'APPDATA',
    })
  })

  it('puts Kilo in ~/.config/kilo, with KILO_CONFIG naming its settings file', () => {
    expect(summary(locations('kilo', {}, '/home/me', 'linux'))).toEqual([
      { id: 'folder', candidates: ['/home/me/.config/kilo'], env: null },
      {
        id: 'settings',
        candidates: ['/home/me/.config/kilo/kilo.jsonc', '/home/me/.config/kilo/kilo.json'],
        env: null,
      },
      { id: 'instructions', candidates: ['/home/me/.config/kilo/AGENTS.md'], env: null },
    ])
    expect(summary(locations('kilo', { XDG_CONFIG_HOME: '/xdg' }, '/home/me', 'linux'))[0]).toEqual(
      { id: 'folder', candidates: ['/xdg/kilo'], env: 'XDG_CONFIG_HOME' },
    )
    const custom = summary(
      locations('kilo', { KILO_CONFIG: '/etc/kilo/kilo.jsonc' }, '/home/me', 'linux'),
    )
    expect(custom[1]).toEqual({
      id: 'settings',
      candidates: ['/etc/kilo/kilo.jsonc'],
      env: 'KILO_CONFIG',
    })
    expect(custom[0]).toMatchObject({ candidates: ['/home/me/.config/kilo'], env: null })
  })
})
