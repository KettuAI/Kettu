import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CatalogPlugin } from '@shared/marketplace'
import type { ProgramOptions, ProgramRun } from '../adapter-install'
import { TextRing } from '../ring'
import type { CodexRequest } from './codex-plugins'
import { MarketPluginsService, pluginsFile } from './plugins'

function plugin(name: string, installs: number | null = 10): CatalogPlugin {
  return {
    id: `${name}@claude-plugins-official`,
    harness: 'claude-code',
    name,
    title: name,
    description: `The ${name} plugin`,
    publisher: null,
    official: true,
    marketplace: 'claude-plugins-official',
    category: null,
    homepage: null,
    installs,
    version: null,
    featured: false,
  }
}

function entry(catalog: CatalogPlugin[]) {
  return {
    at: 1_700_000_000_000,
    catalog,
    installed: [],
    marketplaces: [],
    paths: {},
    logos: {},
  }
}

let dir: string
const logs: string[] = []
const log = (level: string, message: string): void => void logs.push(`${level}: ${message}`)

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-plugins-'))
  await mkdir(path.join(dir, 'state'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the kept plugin lists', () => {
  // Three Claude Code agents offer nearly the same catalog; one counts an install more.
  const work = [plugin('review'), plugin('lint'), plugin('docs')]
  const personal = [plugin('review'), plugin('lint'), plugin('docs', 11), plugin('extra')]
  const version1 = {
    version: 1,
    agents: {
      'claude-code': entry(work),
      'claude-code~personal': entry(personal),
      'claude-code~company': entry([...work]),
    },
  }

  it('migrates version 1 without losing anything, keeping each plugin once', async () => {
    const file = path.join(dir, 'state', 'market-plugins.json')
    await writeFile(file, JSON.stringify(version1, null, 2))
    const store = pluginsFile(dir, log)
    const loaded = await store.load()
    expect(store.status).toBe('migrated')
    expect(loaded.agents).toEqual(version1.agents)
    await store.flush()
    const written = JSON.parse(await readFile(file, 'utf8'))
    expect(written.version).toBe(2)
    expect(written.plugins).toHaveLength(5)
    expect(written.agents['claude-code~company'].catalog).toEqual(
      written.agents['claude-code'].catalog,
    )
    const reloaded = pluginsFile(dir, log)
    expect((await reloaded.load()).agents).toEqual(version1.agents)
    expect(reloaded.status).toBe('ok')
  })

  it('keeps each plugin once when it saves lists read since', async () => {
    const store = pluginsFile(dir, log)
    const kept = await store.load()
    kept.agents['claude-code'] = entry(work)
    kept.agents['claude-code~personal'] = entry(structuredClone(personal))
    store.save(kept)
    await store.flush()
    const file = path.join(dir, 'state', 'market-plugins.json')
    expect(JSON.parse(await readFile(file, 'utf8')).plugins).toHaveLength(5)
    expect((await pluginsFile(dir, log).load()).agents).toEqual(kept.agents)
  })

  it('drops an entry whose catalog names a plugin the file does not hold', async () => {
    const file = path.join(dir, 'state', 'market-plugins.json')
    const broken = {
      version: 2,
      plugins: [plugin('review')],
      agents: {
        'claude-code': { ...entry([]), catalog: [0] },
        codex: { ...entry([]), catalog: [3] },
      },
    }
    await writeFile(file, JSON.stringify(broken))
    const loaded = await pluginsFile(dir, log).load()
    expect(Object.keys(loaded.agents)).toEqual(['claude-code'])
    expect(loaded.agents['claude-code']!.catalog).toEqual([plugin('review')])
  })
})

describe('a cached read of the plugins', () => {
  const at = 1_700_000_000_000
  async function service(now: number) {
    const file = pluginsFile(dir, log)
    const kept = await file.load()
    kept.agents['claude-code'] = entry([plugin('review')])
    file.save(kept)
    await file.flush()
    const asked: string[] = []
    const plugins = new MarketPluginsService({
      file,
      log,
      platform: 'darwin',
      agents: async () => ['claude-code'],
      program: async (agentId) => {
        asked.push(agentId)
        return null
      },
      appServer: async () => {
        throw new Error('not started in this test')
      },
      now: () => now,
    })
    return { plugins, asked }
  }

  it('answers from a copy older than the hour without asking the harness, saying so', async () => {
    const { plugins, asked } = await service(at + 2 * 60 * 60_000)
    const answer = await plugins.plugins(false, true)
    expect(answer.catalog).toEqual([plugin('review')])
    expect(answer.stale).toBe(true)
    expect(asked).toEqual([])
  })

  it('says a copy within the hour is not old', async () => {
    const { plugins } = await service(at + 60_000)
    expect((await plugins.plugins(false, true)).stale).toBe(false)
  })

  it('still reads an old copy again without cached', async () => {
    const { plugins, asked } = await service(at + 2 * 60 * 60_000)
    const answer = await plugins.plugins()
    expect(asked).toEqual(['claude-code'])
    expect(answer.stale).toBeUndefined()
  })
})

describe("the Kettu Marketplace's local marketplace in an agent", () => {
  const ran = (stdout: string): ProgramRun => ({
    code: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    output: new TextRing(1024),
    stdout,
  })

  function claudeService(installed: string, marketplaces = '[]') {
    const calls: string[] = []
    const plugins = new MarketPluginsService({
      file: pluginsFile(dir, log),
      log,
      platform: 'darwin',
      agents: async () => ['claude-code', 'claude-code~work'],
      program: async () => ({ program: '/opt/claude', env: {} }),
      appServer: async () => {
        throw new Error('not started in this test')
      },
      run: async (options: ProgramOptions) => {
        const args = options.args.join(' ')
        calls.push(args)
        if (args === 'plugin list --json') return ran(installed)
        if (args === 'plugin marketplace list --json') return ran(marketplaces)
        return ran('{"outcome":"ok"}')
      },
    })
    return { plugins, calls }
  }

  function codexService(installed: boolean) {
    const calls: { method: string; params: unknown }[] = []
    const request = (async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method !== 'plugin/list') return {}
      return {
        marketplaces: [
          {
            name: 'kettu-marketplace',
            path: '/old/codex/.agents/plugins/marketplace.json',
            plugins: [
              {
                id: 'hello@kettu-marketplace',
                name: 'hello',
                version: '1.0.0',
                localVersion: null,
                source: { type: 'local' },
                installed,
                enabled: true,
                installPolicy: 'AVAILABLE',
                availability: 'AVAILABLE',
                interface: null,
              },
            ],
          },
        ],
        marketplaceLoadErrors: [],
        featuredPluginIds: [],
      }
    }) as CodexRequest
    const plugins = new MarketPluginsService({
      file: pluginsFile(dir, log),
      log,
      platform: 'darwin',
      agents: async () => ['codex'],
      program: async () => null,
      appServer: async () => request,
    })
    return { plugins, calls }
  }

  it('goes with the last plugin installed from it', async () => {
    const { plugins, calls } = claudeService('[]')
    await plugins.uninstall('claude-code', 'hello@kettu-marketplace', 'user', null)
    expect(calls).toEqual([
      'plugin uninstall hello@kettu-marketplace --scope user --json',
      'plugin list --json',
      'plugin marketplace remove kettu-marketplace --json',
    ])
  })

  it('stays while a plugin from it is installed in any project', async () => {
    const { plugins, calls } = claudeService(
      '[{"id":"other@kettu-marketplace","scope":"project","enabled":true,"projectPath":"/repo"}]',
    )
    await plugins.uninstall('claude-code', 'hello@kettu-marketplace', 'user', null)
    expect(calls.some((args) => args.includes('marketplace remove'))).toBe(false)
  })

  it('is not looked at when a plugin of another marketplace is uninstalled', async () => {
    const { plugins, calls } = claudeService('[]')
    await plugins.uninstall('claude-code', 'review@claude-plugins-official', 'user', null)
    expect(calls).toEqual(['plugin uninstall review@claude-plugins-official --scope user --json'])
  })

  it('goes from Codex with the last plugin installed from it', async () => {
    const { plugins, calls } = codexService(false)
    await plugins.uninstall('codex', 'hello@kettu-marketplace', 'user', null)
    expect(calls.map((call) => call.method)).toEqual([
      'plugin/uninstall',
      'plugin/list',
      'marketplace/remove',
    ])
    expect(calls[2]!.params).toEqual({ marketplaceName: 'kettu-marketplace' })
  })

  it('moves to a new folder only in the agents that have it elsewhere', async () => {
    const { plugins, calls } = claudeService(
      '[]',
      '[{"name":"kettu-marketplace","source":"directory","path":"/old/claude-code","installLocation":"/old/claude-code"}]',
    )
    await plugins.pointLocal('claude-code', {
      dir: '/home/.kettu/plugins/claude-code',
      file: '/home/.kettu/plugins/claude-code/.claude-plugin/marketplace.json',
    })
    expect(calls.filter((args) => args !== 'plugin marketplace list --json')).toEqual([
      'plugin marketplace add /home/.kettu/plugins/claude-code --json',
      'plugin marketplace add /home/.kettu/plugins/claude-code --json',
    ])
    const none = claudeService('[]', '[]')
    await none.plugins.pointLocal('claude-code', {
      dir: '/home/.kettu/plugins/claude-code',
      file: '/home/.kettu/plugins/claude-code/.claude-plugin/marketplace.json',
    })
    expect(none.calls).toEqual(['plugin marketplace list --json', 'plugin marketplace list --json'])
  })

  it('moves to a new folder in Codex without removing it', async () => {
    const { plugins, calls } = codexService(true)
    await plugins.pointLocal('codex', {
      dir: '/home/.kettu/plugins/codex',
      file: '/home/.kettu/plugins/codex/.agents/plugins/marketplace.json',
    })
    expect(calls.map((call) => call.method)).toEqual(['plugin/list', 'marketplace/add'])
    expect(calls[1]!.params).toEqual({ source: '/home/.kettu/plugins/codex' })
  })
})
