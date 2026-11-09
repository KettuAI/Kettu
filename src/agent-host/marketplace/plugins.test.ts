import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PluginListResponse } from '../codex/protocol'
import { tempFolder } from '../testing/temp'
import { MarketPluginsService, parsePluginsFile, pluginsFile } from './plugins'

const LIST: PluginListResponse = {
  marketplaces: [
    {
      name: 'openai-curated',
      path: '/codex/marketplace.json',
      interface: null,
      plugins: [
        {
          id: 'linear@openai-curated',
          name: 'linear',
          version: '1.0.0',
          localVersion: null,
          source: { type: 'local' },
          installed: false,
          enabled: false,
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

async function setup() {
  const dir = await tempFolder('kettu-plugins-')
  const state = { now: 0, calls: [] as [string, unknown][], fail: false }
  const service = new MarketPluginsService({
    file: pluginsFile(dir, () => {}),
    log: () => {},
    platform: 'darwin',
    agents: async () => ['codex'],
    program: async () => ({ program: '/opt/codex', env: {} }),
    appServer:
      async () =>
      async <T>(method: string, params?: unknown) => {
        state.calls.push([method, params])
        if (state.fail) throw new Error('app-server is gone')
        return (method === 'plugin/list' ? LIST : {}) as T
      },
    now: () => state.now,
  })
  return { dir, state, service }
}

describe('MarketPluginsService', () => {
  it("keeps each agent's lists for an hour in the host's state", async () => {
    const { dir, state, service } = await setup()
    const first = await service.plugins()
    expect(first.catalog.map((plugin) => plugin.id)).toEqual(['linear@openai-curated'])
    expect(first.errors).toEqual([])
    state.now = 59 * 60_000
    await service.plugins()
    expect(state.calls.filter(([method]) => method === 'plugin/list')).toHaveLength(1)
    await service.plugins(true)
    expect(state.calls.filter(([method]) => method === 'plugin/list')).toHaveLength(2)

    await service.flush()
    const stored = JSON.parse(
      await readFile(path.join(dir, 'state', 'market-plugins.json'), 'utf8'),
    )
    expect(stored.agents.codex.paths).toEqual({
      'linear@openai-curated': '/codex/marketplace.json',
    })
  })

  it('serves the lists from before with the reason when the harness fails', async () => {
    const { state, service } = await setup()
    await service.plugins()
    state.fail = true
    const failed = await service.plugins(true)
    expect(failed.errors).toEqual([{ agentId: 'codex', message: 'app-server is gone' }])
    expect(failed.catalog).toHaveLength(1)
  })

  it("installs through the plugin's marketplace file and reads the lists again after", async () => {
    const { state, service } = await setup()
    await service.plugins()
    await expect(service.install('codex', 'linear@openai-curated', 'user', null)).rejects.toThrow(
      /did not list/,
    )
    expect(state.calls).toContainEqual([
      'plugin/install',
      { marketplacePath: '/codex/marketplace.json', pluginName: 'linear' },
    ])
    const before = state.calls.length
    await service.plugins()
    expect(state.calls.length).toBe(before + 1)
    await expect(
      service.install('codex', 'linear@openai-curated', 'project', '/repo'),
    ).rejects.toThrow(/user only/)
  })
})

describe('parsePluginsFile', () => {
  it("keeps the agents' entries of the written shape and drops the others", () => {
    const good = { at: 1, catalog: [{ id: 'a' }], installed: [], marketplaces: [], paths: {} }
    expect(parsePluginsFile({ version: 1, agents: { codex: good, broken: { at: 'x' } } })).toEqual({
      version: 1,
      agents: { codex: good },
    })
    expect(typeof parsePluginsFile({ version: 1, agents: [] })).toBe('string')
  })
})
