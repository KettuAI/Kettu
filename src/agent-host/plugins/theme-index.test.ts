import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pluginThemeEntries } from '@shared/plugin-themes'
import type { PluginResource } from '@shared/plugins'
import { PluginThemeIndex } from './theme-index'

const resource = (name: string, pluginId = 'p0123456789ab'): PluginResource => ({
  name,
  description: '',
  path: `sh.kettu/themes/${name}.json`,
  pluginId,
  pluginName: 'dusk-kit',
  plugin: 'Dusk kit',
  file: `/data/${pluginId}/v-1/sh.kettu/themes/${name}.json`,
})

describe('the ids of the themes plugins bring', () => {
  it('hold the plugin’s id and two dashes, which a theme from a file never has', () => {
    expect(pluginThemeEntries([resource('Dusk.Night')]).map((item) => item.id)).toEqual([
      'p0123456789ab--dusk-night',
    ])
  })

  it('stay apart within a plugin when two names give the same slug, and fit the id limit', () => {
    const long = 'a'.repeat(60)
    const ids = pluginThemeEntries([
      resource('a.b'),
      resource('a_b'),
      resource('a-b'),
      resource(long),
      resource(`${long}b`),
    ]).map((item) => item.id)
    expect(new Set(ids).size).toBe(5)
    expect(ids.slice(0, 3)).toEqual([
      'p0123456789ab--a-b',
      'p0123456789ab--a-b-2',
      'p0123456789ab--a-b-3',
    ])
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/)
  })
})

describe('the index of the themes plugins bring', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'kettu-theme-index-'))
    file = path.join(dir, 'plugin-themes.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function make(resources: () => PluginResource[]) {
    let changed = 0
    const index = new PluginThemeIndex({
      file,
      resources: async () => resources(),
      changed: () => changed++,
      log: () => {},
    })
    return { index, changed: () => changed }
  }

  it('lists the themes as the plugins stand, and says so only when the file changes', async () => {
    let list = [resource('dusk')]
    const { index, changed } = make(() => list)
    await index.sync()
    await index.sync()
    expect(changed()).toBe(1)
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      version: 1,
      themes: [{ id: 'p0123456789ab--dusk', pluginId: 'p0123456789ab', plugin: 'Dusk kit' }],
    })
    list = []
    await index.sync()
    expect(changed()).toBe(2)
    expect(JSON.parse(await readFile(file, 'utf8')).themes).toEqual([])
  })

  it('does not say so when a restart finds the file as it left it', async () => {
    const first = make(() => [resource('dusk')])
    await first.index.sync()
    const second = make(() => [resource('dusk')])
    await second.index.sync()
    expect(second.changed()).toBe(0)
    await writeFile(file, 'stale')
    await second.index.sync()
    expect(second.changed()).toBe(0)
  })
})
