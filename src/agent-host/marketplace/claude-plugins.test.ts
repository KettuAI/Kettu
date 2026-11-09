// Fixtures trimmed from Claude Code 2.1.319's `claude plugin` output in a throwaway configuration
// folder with Anthropic's marketplace added and commit-commands installed, then disabled.

import { describe, expect, it } from 'vitest'
import type { ProgramOptions, ProgramRun } from '../adapter-install'
import { TextRing } from '../ring'
import {
  claudeCatalog,
  installPlugin,
  lastJsonLine,
  listPlugins,
  parseDetails,
  parseManifest,
  parseMarketplaces,
  parsePluginList,
  type ClaudeCli,
} from './claude-plugins'

const MARKETPLACES = JSON.stringify([
  {
    name: 'claude-plugins-official',
    source: 'github',
    repo: 'anthropics/claude-plugins-official',
    installLocation: '/tmp/cc/plugins/marketplaces/claude-plugins-official',
  },
])

const available = (
  name: string,
  marketplace: string,
  installs: number | null,
  source: unknown = `./plugins/${name}`,
) => ({
  pluginId: `${name}@${marketplace}`,
  name,
  description: `${name} plugin`,
  marketplaceName: marketplace,
  source,
  ...(installs === null ? { version: '6.4.2' } : { installCount: installs }),
})

const LIST = JSON.stringify({
  installed: [
    {
      id: 'commit-commands@claude-plugins-official',
      version: '1.0.1',
      scope: 'user',
      enabled: false,
      installPath: '/tmp/cc/plugins/cache/claude-plugins-official/commit-commands/1.0.1',
      installedAt: '2026-11-09T14:55:42.012Z',
      lastUpdated: '2026-11-09T14:55:42.012Z',
      projectEnabled: false,
    },
    { id: '(suppressed)@skills-dir', version: 'unknown', scope: 'project', enabled: false },
  ],
  available: [
    available('42crunch-api-security-testing', 'claude-plugins-official', 3474, {
      source: 'git-subdir',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      path: 'plugins/api-security-testing',
    }),
    available('frontend-design', 'claude-plugins-official', 1266133),
    ...Array.from({ length: 12 }, (_, i) => available(`tool-${i}`, 'claude-plugins-official', i)),
    available('frontend-design', 'anthropic-plugin-directory', null, {
      source: 'git-subdir',
      url: 'https://github.com/anthropics/claude-plugins-official',
    }),
    available('superpowers', 'anthropic-plugin-directory', null, {
      source: 'url',
      url: 'https://github.com/obra/superpowers.git',
    }),
  ],
})

const MANIFEST = {
  name: 'claude-plugins-official',
  owner: { name: 'Anthropic', email: 'support@anthropic.com' },
  plugins: [
    {
      name: '42crunch-api-security-testing',
      author: { name: '42Crunch' },
      category: 'security',
      homepage: 'https://42crunch.com',
      source: { source: 'git-subdir', url: 'https://github.com/42Crunch-AI/claude-plugins.git' },
    },
    {
      name: 'frontend-design',
      displayName: 'Frontend Design',
      category: 'development',
      version: '1.1.1',
      source: './plugins/frontend-design',
    },
  ],
}

const DETAILS = `commit-commands 1.0.1
  Description: Commands for git commit workflows including commit, push, and PR creation
  Source: commit-commands@claude-plugins-official

Component inventory
  Skills (3)  clean_gone, commit, commit-push-pr
  Agents (0)
  Hooks (0)
  MCP servers (2)  github, linear
  LSP servers (0)

Projected token cost
  Always-on:   ~71 tok   added to every session
`

function run(stdout: string, code = 0): ProgramRun {
  return { code, signal: null, timedOut: false, aborted: false, output: new TextRing(1024), stdout }
}

function cli(answer: (args: readonly string[]) => ProgramRun): {
  cli: ClaudeCli
  calls: ProgramOptions[]
} {
  const calls: ProgramOptions[] = []
  return {
    calls,
    cli: {
      agentId: 'claude-code',
      program: '/opt/claude',
      env: { CLAUDE_CONFIG_DIR: '/tmp/cc' },
      platform: 'darwin',
      run: async (options) => {
        calls.push(options)
        return answer(options.args)
      },
    },
  }
}

describe("Claude Code's plugin lists", () => {
  it('reads the marketplaces and the installed plugins, without the skills folder', () => {
    expect(parseMarketplaces(MARKETPLACES)).toEqual([
      {
        name: 'claude-plugins-official',
        source: 'anthropics/claude-plugins-official',
        installLocation: '/tmp/cc/plugins/marketplaces/claude-plugins-official',
      },
    ])
    expect(parsePluginList(LIST).installed).toEqual([
      {
        id: 'commit-commands@claude-plugins-official',
        version: '1.0.1',
        scope: 'user',
        enabled: false,
        projectPath: null,
      },
    ])
    expect(() => parsePluginList('not json')).toThrow(/not JSON/)
  })

  it('lists the catalog: official, featured by installs, enriched from marketplace.json', () => {
    const list = parsePluginList(LIST)
    const manifests = new Map([['claude-plugins-official', parseManifest(MANIFEST)]])
    const catalog = claudeCatalog(list.available, manifests, parseMarketplaces(MARKETPLACES))
    const ids = catalog.map((plugin) => plugin.id)
    // The directory's copy of a plugin a marketplace offers is left out; its others stay.
    expect(ids).not.toContain('frontend-design@anthropic-plugin-directory')
    expect(ids).toContain('superpowers@anthropic-plugin-directory')
    expect(catalog.filter((plugin) => plugin.featured)).toHaveLength(12)
    expect(catalog.find((plugin) => plugin.id === 'tool-0@claude-plugins-official')?.featured).toBe(
      false,
    )
    expect(catalog.find((plugin) => plugin.name === 'frontend-design')).toMatchObject({
      title: 'Frontend Design',
      publisher: 'Anthropic',
      official: true,
      category: 'development',
      version: '1.1.1',
      installs: 1266133,
      featured: true,
    })
    expect(catalog.find((plugin) => plugin.name.startsWith('42crunch'))).toMatchObject({
      publisher: '42Crunch',
      homepage: 'https://42crunch.com/',
      category: 'security',
    })
    expect(catalog.find((plugin) => plugin.name === 'superpowers')).toMatchObject({
      publisher: 'obra',
      official: false,
      installs: null,
      version: '6.4.2',
    })
  })

  it("reads `plugin details`' inventory and its always-on cost from the text it prints", () => {
    expect(parseDetails(DETAILS, 'commit-commands@claude-plugins-official', 'claude-code')).toEqual(
      {
        id: 'commit-commands@claude-plugins-official',
        agentId: 'claude-code',
        description: 'Commands for git commit workflows including commit, push, and PR creation',
        skills: ['clean_gone', 'commit', 'commit-push-pr'],
        commands: [],
        agents: [],
        hooks: [],
        mcpServers: ['github', 'linear'],
        lspServers: [],
        alwaysOnTokens: 71,
      },
    )
    expect(parseDetails('something else entirely', 'a@b', 'claude-code')).toMatchObject({
      description: null,
      skills: [],
      alwaysOnTokens: null,
    })
  })

  it('takes the last JSON line of a change', () => {
    expect(lastJsonLine('Installing…\n{"command":"install","outcome":"ok"}\n')).toEqual({
      command: 'install',
      outcome: 'ok',
    })
    expect(lastJsonLine('no json here')).toBeNull()
  })
})

describe("Claude Code's plugin commands", () => {
  it("adds Anthropic's marketplace to an agent that has none, then lists", async () => {
    let added = false
    const { cli: claude, calls } = cli((args) => {
      if (args.join(' ') === 'plugin marketplace list --json')
        return run(added ? MARKETPLACES : '[]')
      if (args[1] === 'marketplace' && args[2] === 'add') {
        added = true
        return run(
          '{"command":"marketplace add","outcome":"ok","marketplace":"claude-plugins-official"}',
        )
      }
      return run(LIST)
    })
    const list = await listPlugins(claude)
    expect(calls.map((call) => call.args.join(' '))).toEqual([
      'plugin marketplace list --json',
      'plugin marketplace add anthropics/claude-plugins-official --json',
      'plugin marketplace list --json',
      'plugin list --available --json',
    ])
    expect(calls.every((call) => call.program === '/opt/claude')).toBe(true)
    expect(calls[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: '/tmp/cc' })
    expect(list.marketplaces).toEqual([
      {
        harness: 'claude-code',
        agentId: 'claude-code',
        name: 'claude-plugins-official',
        source: 'anthropics/claude-plugins-official',
        official: true,
      },
    ])
  })

  it('never accepts a command a marketplace declares: the install fails with its message', async () => {
    const asked =
      '{"command":"install","outcome":"confirmation-required","message":"This plugin runs a command its marketplace declares; review it with claude plugin install","shownCommand":{"sha256":"ab"}}'
    const { cli: claude, calls } = cli(() => run(asked, 1))
    await expect(installPlugin(claude, 'tool@market', 'project', '/repo')).rejects.toThrow(
      /runs a command its marketplace declares/,
    )
    expect(calls[0]!.args).toEqual([
      'plugin',
      'install',
      'tool@market',
      '--scope',
      'project',
      '--json',
    ])
    expect(calls[0]!.cwd).toBe('/repo')
    expect(
      calls[0]!.args.some((arg) => arg === '-y' || arg === '--yes' || arg.startsWith('--accept')),
    ).toBe(false)
  })
})
