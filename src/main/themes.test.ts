import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PLUGIN_THEMES_VERSION } from '@shared/plugin-themes'
import { BUILTIN_THEME_ID } from '@shared/themes'
import type { ThemeCatalog } from './theme-catalog'
import { readPluginThemes, ThemeStore, type ThemeFolder } from './themes'

const PLUGIN = 'p0123456789ab'
const ID = `${PLUGIN}--dusk`

const themeText = (name: string, color = '#101820'): string =>
  JSON.stringify({
    kettuTheme: 1,
    name,
    light: { colors: { 'bg-sidebar': '#ffffff' } },
    dark: { colors: { 'bg-sidebar': color } },
  })

let dir: string
let index: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-plugin-themes-'))
  index = join(dir, 'plugin-themes.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function writeIndex(themes: unknown[], version: number = PLUGIN_THEMES_VERSION) {
  await writeFile(index, JSON.stringify({ version, themes }))
}

const entry = (file: string, id = ID, pluginId = PLUGIN) => ({
  id,
  pluginId,
  plugin: 'Dusk kit',
  file,
})

describe('the themes plugins bring', () => {
  it('reads each file as a theme file is read, and marks it with its plugin', async () => {
    const file = join(dir, 'dusk.json')
    await writeFile(file, themeText('Dusk'))
    await writeIndex([entry(file)])
    const read = await readPluginThemes(index)
    expect(read.installed).toMatchObject([
      { id: ID, theme: { name: 'Dusk' }, plugin: { id: PLUGIN, title: 'Dusk kit' } },
    ])
  })

  it('refuses a file that fails the checks of a theme file, which no color can get around', async () => {
    const bad = join(dir, 'bad.json')
    await writeFile(
      bad,
      JSON.stringify({
        kettuTheme: 1,
        name: 'Bad',
        light: { colors: { 'bg-sidebar': 'url(https://example.com/x.png)' } },
        dark: { colors: {} },
      }),
    )
    const huge = join(dir, 'huge.json')
    await writeFile(huge, themeText('Huge') + ' '.repeat(300 * 1024))
    await writeIndex([
      entry(bad, `${PLUGIN}--bad`),
      entry(huge, `${PLUGIN}--huge`),
      entry(join(dir, 'gone.json'), `${PLUGIN}--gone`),
    ])
    const read = await readPluginThemes(index)
    expect(read.installed).toEqual([])
    expect([...read.failed]).toEqual([
      [
        `${PLUGIN}--bad`,
        { code: 'invalid', error: { code: 'invalid-color', path: 'light.colors.bg-sidebar' } },
      ],
      [`${PLUGIN}--huge`, { code: 'invalid', error: { code: 'too-large' } }],
      [`${PLUGIN}--gone`, { code: 'unreadable' }],
    ])
  })

  it('takes nothing from an index that is not the host’s, in whole or in part', async () => {
    const file = join(dir, 'dusk.json')
    await writeFile(file, themeText('Dusk'))
    await writeIndex([entry(file)], 2)
    expect((await readPluginThemes(index)).installed).toEqual([])
    await writeIndex([
      // An id a theme installed from a file could have, which would take its place.
      entry(file, 'dusk'),
      entry(file, BUILTIN_THEME_ID),
      // An id under another plugin's name, a file that is not absolute, and a repeated id.
      entry(file, `p0123456789ac--dusk`),
      entry('dusk.json', `${PLUGIN}--rel`),
      entry(file),
      entry(file),
    ])
    expect((await readPluginThemes(index)).installed.map((item) => item.id)).toEqual([ID])
    await writeFile(index, '{')
    expect((await readPluginThemes(index)).installed).toEqual([])
  })
})

describe('the themes shown with the plugins’ themes', () => {
  const none: ThemeFolder = { installed: [], failed: new Map() }

  async function store(chosen: string) {
    const file = join(dir, 'dusk.json')
    await writeFile(file, themeText('Dusk'))
    await writeIndex([entry(file)])
    const changes: string[] = []
    const themes = new ThemeStore(none, new Map(), await readPluginThemes(index), chosen, {
      dir: join(dir, 'themes'),
      sourcesFile: join(dir, 'theme-sources.json'),
      pluginFile: index,
      catalog: {} as ThemeCatalog,
      select: () => {},
      changed: (state) => changes.push(state.chosen),
    })
    return { themes, changes }
  }

  it('lists them for the window and the devices, and shows the chosen one', async () => {
    const { themes } = await store(ID)
    expect(themes.state()).toMatchObject({
      chosen: ID,
      failed: null,
      installed: [{ id: ID, plugin: { title: 'Dusk kit' } }],
    })
    expect(themes.chosenTheme()?.name).toBe('Dusk')
    expect(themes.hostThemes().installed.map((item) => item.id)).toEqual([ID])
  })

  it('removes them with the plugin, so the built-in theme shows, and never alone', async () => {
    const { themes, changes } = await store(ID)
    await expect(themes.remove(ID)).rejects.toThrow('Not an installed theme')
    expect(() => themes.fileOf(ID)).toThrow('Not an installed theme')
    await writeIndex([])
    await themes.refresh()
    expect(changes).toEqual([ID])
    expect(themes.state()).toMatchObject({ installed: [], failed: { id: ID } })
    expect(themes.chosenTheme()).toBeNull()
    // The plugin comes back on: the theme is there again, and the setting never changed.
    await writeIndex([entry(join(dir, 'dusk.json'))])
    await themes.refresh()
    expect(themes.state().failed).toBeNull()
    expect(themes.chosenTheme()?.name).toBe('Dusk')
  })
})
