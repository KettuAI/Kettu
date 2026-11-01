import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThemesState } from '@shared/themes'

const electron = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  showItemInFolder: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  dialog: { showOpenDialog: electron.open, showSaveDialog: electron.save },
  shell: { showItemInFolder: electron.showItemInFolder },
  protocol: {},
}))

const { checkThemeText, readThemeFolder, readThemeSources, themeId, ThemeStore, windowColors } =
  await import('./themes')
const { CATALOG_URL, ThemeCatalog } = await import('./theme-catalog')
const { exportThemeFile, installThemeFile, revealThemeFile } = await import('./theme-dialogs')

const WINDOW = {} as Electron.BrowserWindow

const theme = (name: string, dark: Record<string, string> = { 'bg-app': '#2e3440' }) =>
  JSON.stringify({ kettuTheme: 1, name, light: {}, dark: { colors: dark } })

let dir: string
let themesDir: string
let sourcesFile: string
// What the catalog's fake fetch answers, by path under CATALOG_URL.
let served: Record<string, string>

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-themes-'))
  themesDir = path.join(dir, 'themes')
  sourcesFile = path.join(dir, 'theme-sources.json')
  served = {}
  await mkdir(themesDir)
  vi.clearAllMocks()
})

const fetchCatalog = async (url: string) => {
  const body = served[url.slice(CATALOG_URL.length)]
  return body === undefined ? new Response(null, { status: 404 }) : new Response(body)
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function put(name: string, text: string | Buffer): Promise<string> {
  const file = path.join(dir, name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
  return file
}

describe('themeId', () => {
  it('is the name in ASCII, or a hash of a name with none', () => {
    expect(themeId('Rosé Pine Dawn')).toBe('rose-pine-dawn')
    const hash = createHash('sha256').update('墨').digest('hex').slice(0, 8)
    expect(themeId('墨')).toBe(`theme-${hash}`)
  })
})

describe('readThemeFolder', () => {
  it('reads the themes by name and keeps why the others fail', async () => {
    await put('themes/nord.json', theme('Nord'))
    await put('themes/ayu.json', `\uFEFF${theme('Ayu')}`)
    await put('themes/broken.json', theme('Broken', { 'bg-app': 'var(--x)' }))
    await put('themes/big.json', ' '.repeat(256 * 1024 + 1))
    await put('themes/latin1.json', Buffer.from([0x7b, 0xe9, 0x7d]))
    // Not theme ids, so never read.
    await put('themes/Nord Copy.json', theme('Nord Copy'))
    await put('themes/kettu.json', theme('Over'))
    await put('themes/notes.txt', 'x')
    await put('themes/nord.json.tmp', 'x')

    const folder = await readThemeFolder(themesDir)
    expect(folder.installed.map((item) => [item.id, item.theme.name])).toEqual([
      ['ayu', 'Ayu'],
      ['nord', 'Nord'],
    ])
    expect(Object.fromEntries(folder.failed)).toEqual({
      broken: { code: 'invalid', error: { code: 'invalid-color', path: 'dark.colors.bg-app' } },
      big: { code: 'invalid', error: { code: 'too-large' } },
      latin1: { code: 'invalid', error: { code: 'not-json' } },
    })
  })

  it('holds nothing when the folder is missing', async () => {
    const folder = await readThemeFolder(path.join(dir, 'none'))
    expect(folder.installed).toEqual([])
    expect(folder.failed.size).toBe(0)
  })
})

describe('ThemeStore', () => {
  const changed = vi.fn<(state: ThemesState, chosen: unknown) => void>()

  async function store(chosen = 'kettu') {
    const themes: InstanceType<typeof ThemeStore> = new ThemeStore(
      await readThemeFolder(themesDir),
      await readThemeSources(sourcesFile),
      chosen,
      {
        dir: themesDir,
        sourcesFile,
        catalog: new ThemeCatalog(fetchCatalog),
        // As settings.json does: the setting changes, and its listener tells the store.
        select: (id) => themes.choose(id),
        changed,
      },
    )
    return themes
  }

  /** Serves `files` as the catalog, each listed in the index at `version`. */
  function serveCatalog(files: Record<string, string>, version = '1.0.0') {
    const themes = Object.entries(files).map(([id, text]) => ({
      id,
      name: JSON.parse(text).name,
      author: 'Someone',
      version,
      license: 'MIT',
      file: `themes/${id}.json`,
      sha256: createHash('sha256').update(text).digest('hex'),
      preview: { light: {}, dark: { 'bg-app': '#2e3440' } },
    }))
    served = { 'index.json': JSON.stringify({ kettuCatalog: 1, themes }) }
    for (const [id, text] of Object.entries(files)) served[`themes/${id}.json`] = text
  }

  const sources = async () => JSON.parse(await readFile(sourcesFile, 'utf8'))

  const chooseFile = (file: string | null) =>
    electron.open.mockResolvedValue({ canceled: file === null, filePaths: file ? [file] : [] })

  it('says why the chosen theme does not load', async () => {
    await put('themes/broken.json', '{')
    expect((await store('nord')).state().failed).toEqual({
      id: 'nord',
      failure: { code: 'missing' },
    })
    expect((await store('broken')).state().failed).toEqual({
      id: 'broken',
      failure: { code: 'invalid', error: { code: 'not-json' } },
    })
    expect((await store('broken')).chosenTheme()).toBeNull()
    expect((await store()).state().failed).toBeNull()
  })

  it('installs a checked file under its id and chooses it', async () => {
    const source = theme('Rosé Pine', { 'bg-app': '#191724', 'bg-ap': '#000' })
    chooseFile(await put('downloads/rose.json', source))
    const themes = await store()

    expect(await installThemeFile(themes, WINDOW)).toEqual({
      status: 'installed',
      id: 'rose-pine',
      ignored: ['dark.colors.bg-ap'],
    })
    expect(electron.open).toHaveBeenCalledWith(WINDOW, {
      title: 'Install Theme',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    expect(await readFile(path.join(themesDir, 'rose-pine.json'), 'utf8')).toBe(source)
    expect(themes.state().chosen).toBe('rose-pine')
    expect(themes.chosenTheme()?.name).toBe('Rosé Pine')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0]![0].installed.map((item) => item.id)).toEqual(['rose-pine'])
  })

  it('writes nothing for a file that fails the check, or when the user cancels', async () => {
    chooseFile(await put('downloads/x.json', theme('X', { 'bg-app': '#fff;}html{color:red' })))
    const themes = await store()
    expect(await installThemeFile(themes, null)).toEqual({
      status: 'failed',
      file: 'x.json',
      error: { code: 'invalid-color', path: 'dark.colors.bg-app' },
    })
    chooseFile(path.join(dir, 'gone.json'))
    expect(await installThemeFile(themes, null)).toEqual({
      status: 'failed',
      file: 'gone.json',
      error: { code: 'unreadable' },
    })
    chooseFile(null)
    expect(await installThemeFile(themes, null)).toEqual({ status: 'cancelled' })
    expect(await readdir(themesDir)).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })

  it('asks before it replaces an installed theme, and replaces it on the token', async () => {
    await put('themes/nord.json', theme('Nord'))
    const newer = theme('NORD', { 'bg-app': '#242933' })
    chooseFile(await put('downloads/nord.json', newer))
    const themes = await store('nord')

    const answer = await installThemeFile(themes, null)
    expect(answer).toEqual({
      status: 'conflict',
      token: expect.any(String),
      name: 'NORD',
      installedName: 'Nord',
    })
    expect(themes.chosenTheme()?.name).toBe('Nord')
    await expect(themes.replace('another')).rejects.toThrow('No theme is waiting')

    const token = answer.status === 'conflict' ? answer.token : ''
    expect(await themes.replace(token)).toEqual({ status: 'installed', id: 'nord', ignored: [] })
    expect(await readFile(path.join(themesDir, 'nord.json'), 'utf8')).toBe(newer)
    // The chosen theme's file changed, so the store tells everyone though the setting did not.
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0]![1]).toMatchObject({ name: 'NORD' })
    await expect(themes.replace(token)).rejects.toThrow('No theme is waiting')
  })

  it("installs a device's file for that device, leaving the theme this host shows", async () => {
    await put('themes/broken.json', '{')
    const themes = await store()
    const device = vi.fn<(id: string) => void>()
    expect(await themes.add('nord.json', checkThemeText(theme('Nord')), device)).toEqual({
      status: 'installed',
      id: 'nord',
      ignored: [],
    })
    expect(device).toHaveBeenCalledWith('nord')
    expect(themes.state().chosen).toBe('kettu')
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ chosen: 'kettu' }), null)
    const answer = await themes.add(
      'nord.json',
      checkThemeText(theme('Nord', { fg: '#fff' })),
      device,
    )
    expect(answer).toMatchObject({ status: 'conflict', name: 'Nord', installedName: 'Nord' })
    device.mockClear()
    await themes.replace((answer as { token: string }).token)
    expect(device).toHaveBeenCalledWith('nord')
    expect(themes.state().chosen).toBe('kettu')
    expect(themes.hostThemes()).toEqual({
      installed: [expect.objectContaining({ id: 'nord' })],
      failed: [{ id: 'broken', failure: { code: 'invalid', error: { code: 'not-json' } } }],
    })
  })

  it("holds a device's text to a theme file's size", () => {
    expect(checkThemeText(' '.repeat(256 * 1024 + 1))).toEqual({
      ok: false,
      error: { code: 'too-large' },
    })
    expect(checkThemeText(theme('Nord'))).toMatchObject({ ok: true, theme: { name: 'Nord' } })
  })

  it('removes a theme, and brings back the built-in one for the chosen theme', async () => {
    await put('themes/nord.json', theme('Nord'))
    await put('themes/ayu.json', theme('Ayu'))
    const themes = await store('nord')

    await themes.remove('ayu')
    expect(themes.state()).toMatchObject({ chosen: 'nord', failed: null })
    await themes.remove('nord')
    expect(themes.state()).toEqual({ installed: [], chosen: 'kettu', failed: null })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls[1]![1]).toBeNull()
    expect(await readdir(themesDir)).toEqual([])
  })

  it('refuses ids it does not hold', async () => {
    await put('settings.json', '{}')
    const themes = await store()
    for (const id of ['../settings', 'nord', 'kettu', 7]) {
      await expect(themes.remove(id)).rejects.toThrow('Not an installed theme')
      expect(() => revealThemeFile(themes, id)).toThrow('Not an installed theme')
    }
    expect(await readFile(path.join(dir, 'settings.json'), 'utf8')).toBe('{}')
  })

  it('reveals a theme file, a broken one too', async () => {
    await put('themes/broken.json', '{')
    revealThemeFile(await store(), 'broken')
    expect(electron.showItemInFolder).toHaveBeenCalledWith(path.join(themesDir, 'broken.json'))
  })

  it('reads the folder again, telling everyone only when it changed', async () => {
    await put('themes/nord.json', theme('Nord'))
    const themes = await store('nord')
    await themes.refresh()
    expect(changed).not.toHaveBeenCalled()

    await put('themes/nord.json', theme('Nord', { 'bg-app': 'oops' }))
    expect((await themes.refresh()).failed).toEqual({
      id: 'nord',
      failure: { code: 'invalid', error: { code: 'invalid-color', path: 'dark.colors.bg-app' } },
    })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0]![1]).toBeNull()
  })

  it('exports a checked file where the user says', async () => {
    const themes = await store()
    const target = path.join(dir, 'out.json')
    electron.save.mockResolvedValue({ canceled: false, filePath: target })
    const source = theme('My Theme')
    expect(await exportThemeFile(themes, WINDOW, source)).toBe(target)
    expect(await readFile(target, 'utf8')).toBe(source)
    expect(electron.save).toHaveBeenCalledWith(WINDOW, {
      title: 'Export Theme',
      defaultPath: path.join('/downloads', 'My Theme.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })

    electron.save.mockResolvedValue({ canceled: true, filePath: '' })
    expect(await exportThemeFile(themes, null, source)).toBeNull()
    await expect(exportThemeFile(themes, null, '{"name": "x"}')).rejects.toThrow('Not a theme file')
    await expect(exportThemeFile(themes, null, 5)).rejects.toThrow('must be text')
    expect(electron.save).toHaveBeenCalledTimes(2)
  })

  describe('the catalog', () => {
    const nord = theme('Nord')
    const ayu = theme('Ayu', { 'bg-app': '#0b0e14' })

    it("lists the catalog's themes by name with what installing each does", async () => {
      await put('themes/nord.json', nord)
      await put('themes/ayu.json', ayu)
      await put('themes/rose.json', theme('Rose'))
      await put(
        'theme-sources.json',
        JSON.stringify({ version: 1, catalog: { nord: '0.9.0', ayu: '1.0.0' } }),
      )
      serveCatalog({ nord, rose: theme('Rose'), ayu, zen: theme('Zen') })
      const result = await (await store()).catalog(true)
      expect(result.status === 'ok' && result.themes.map((t) => [t.id, t.action])).toEqual([
        ['ayu', 'installed'],
        ['nord', 'update'],
        // Installed from a file: installing asks first.
        ['rose', 'install'],
        ['zen', 'install'],
      ])
      expect(result.status === 'ok' && result.themes[0]).toEqual({
        id: 'ayu',
        name: 'Ayu',
        author: 'Someone',
        version: '1.0.0',
        license: 'MIT',
        preview: { light: {}, dark: { 'bg-app': '#2e3440' } },
        action: 'installed',
      })
    })

    it('says why the catalog cannot be read', async () => {
      expect(await (await store()).catalog(true)).toEqual({ status: 'unreachable' })
      served = { 'index.json': '{"kettuCatalog": 2, "themes": []}' }
      expect(await (await store()).catalog(true)).toEqual({ status: 'newer-format' })
    })

    it('installs a catalog theme, records its version and chooses it', async () => {
      serveCatalog({ nord })
      const themes = await store()
      await themes.catalog(true)
      expect(await themes.installCatalog('nord')).toEqual({
        status: 'installed',
        id: 'nord',
        ignored: [],
      })
      expect(await readFile(path.join(themesDir, 'nord.json'), 'utf8')).toBe(nord)
      expect(await sources()).toEqual({ version: 1, catalog: { nord: '1.0.0' } })
      expect(themes.state()).toMatchObject({
        chosen: 'nord',
        installed: [{ id: 'nord', catalog: '1.0.0' }],
      })
      expect(changed).toHaveBeenCalledTimes(1)
    })

    it('updates a catalog theme without asking and keeps the chosen theme', async () => {
      await put('themes/nord.json', nord)
      await put('themes/ayu.json', ayu)
      await put('theme-sources.json', JSON.stringify({ version: 1, catalog: { nord: '1.0.0' } }))
      const newer = theme('Nord', { 'bg-app': '#242933' })
      serveCatalog({ nord: newer }, '1.1.0')
      const themes = await store('ayu')
      await themes.catalog(true)
      expect(await themes.installCatalog('nord')).toMatchObject({ status: 'installed' })
      expect(await readFile(path.join(themesDir, 'nord.json'), 'utf8')).toBe(newer)
      expect(await sources()).toEqual({ version: 1, catalog: { nord: '1.1.0' } })
      expect(themes.state().chosen).toBe('ayu')
      expect(changed).toHaveBeenCalledTimes(1)
      expect(changed.mock.calls[0]![0].installed.find((t) => t.id === 'nord')?.catalog).toBe(
        '1.1.0',
      )
    })

    it('asks before it replaces a file theme, and records the catalog version on the yes', async () => {
      await put('themes/nord.json', theme('Nord', { 'bg-app': '#000' }))
      serveCatalog({ nord })
      const themes = await store()
      await themes.catalog(true)
      const answer = await themes.installCatalog('nord')
      expect(answer).toEqual({
        status: 'conflict',
        token: expect.any(String),
        name: 'Nord',
        installedName: 'Nord',
      })
      const token = answer.status === 'conflict' ? answer.token : ''
      expect(await themes.replace(token)).toEqual({ status: 'installed', id: 'nord', ignored: [] })
      expect(await readFile(path.join(themesDir, 'nord.json'), 'utf8')).toBe(nord)
      expect(await sources()).toEqual({ version: 1, catalog: { nord: '1.0.0' } })
      expect(themes.state().chosen).toBe('nord')
    })

    it('installs nothing when the download differs from the index or names another id', async () => {
      serveCatalog({ nord, ayu })
      served['themes/nord.json'] = theme('Nord', { 'bg-app': '#000' })
      served['themes/ayu.json'] = theme('Not Ayu', { 'bg-app': '#0b0e14' })
      const index = JSON.parse(served['index.json']!)
      index.themes[1].sha256 = createHash('sha256').update(served['themes/ayu.json']).digest('hex')
      served['index.json'] = JSON.stringify(index)
      const themes = await store()
      await themes.catalog(true)
      for (const id of ['nord', 'ayu']) {
        expect(await themes.installCatalog(id)).toEqual({
          status: 'failed',
          error: { code: 'mismatch' },
        })
      }
      expect(await readdir(themesDir)).toEqual([])
      expect(changed).not.toHaveBeenCalled()
    })

    it('refuses an id the last index does not list', async () => {
      serveCatalog({ nord })
      const themes = await store()
      await expect(themes.installCatalog('nord')).rejects.toThrow('Not a theme in the catalog')
      await themes.catalog(true)
      await expect(themes.installCatalog('ayu')).rejects.toThrow('Not a theme in the catalog')
      await expect(themes.installCatalog(7)).rejects.toThrow('Not a theme in the catalog')
    })

    it('drops the record when a file replaces a catalog theme or it is removed', async () => {
      await put('themes/nord.json', nord)
      await put('themes/ayu.json', ayu)
      await put(
        'theme-sources.json',
        JSON.stringify({ version: 1, catalog: { nord: '1.0.0', ayu: '1.0.0', gone: '1.0.0' } }),
      )
      chooseFile(await put('downloads/nord.json', theme('Nord', { 'bg-app': '#000' })))
      const themes = await store()
      const answer = await installThemeFile(themes, null)
      expect(answer.status).toBe('conflict')
      await themes.replace(answer.status === 'conflict' ? answer.token : '')
      expect(await sources()).toEqual({ version: 1, catalog: { ayu: '1.0.0' } })
      expect(themes.state().installed.find((t) => t.id === 'nord')?.catalog).toBeUndefined()

      await themes.remove('ayu')
      expect(await sources()).toEqual({ version: 1, catalog: {} })
    })
  })
})

describe('readThemeSources', () => {
  it('reads the versions the catalog themes were installed at', async () => {
    const file = await put(
      'theme-sources.json',
      JSON.stringify({ version: 1, catalog: { nord: '1.0.0', '../x': '1.0.0', ayu: 'v1' } }),
    )
    expect(Object.fromEntries(await readThemeSources(file))).toEqual({ nord: '1.0.0' })
  })

  it('counts every theme as a file theme when the file is missing or invalid', async () => {
    expect((await readThemeSources(path.join(dir, 'none.json'))).size).toBe(0)
    for (const text of ['{', '[]', '{"version": 2, "catalog": {}}', '{"version": 1}']) {
      expect((await readThemeSources(await put('theme-sources.json', text))).size).toBe(0)
    }
  })
})

describe('windowColors', () => {
  const fallback = { background: '#ffffff', symbol: '#262626' }

  it("takes the variant's desk and text as hex", () => {
    const colors = {
      'bg-app': '#ffffff',
      'bg-sidebar': '#2E3440',
      'text-primary': 'rgb(236 239 244)',
    }
    expect(windowColors(colors, 'dark', fallback)).toEqual({
      background: '#2e3440',
      symbol: '#eceff4',
    })
  })

  it('lays a translucent background over white or black, and the text over the background', () => {
    const colors = { 'bg-sidebar': 'rgb(255 255 255 / 50%)', 'text-primary': 'rgb(0 0 0 / 50%)' }
    expect(windowColors(colors, 'dark', fallback)).toEqual({
      background: '#808080',
      symbol: '#404040',
    })
    expect(windowColors({ 'bg-sidebar': 'transparent' }, 'light', fallback).background).toBe(
      '#ffffff',
    )
  })

  it('keeps the fallback for what the theme leaves out', () => {
    expect(windowColors({}, 'light', fallback)).toEqual(fallback)
    expect(windowColors({ 'text-primary': '#000' }, 'light', fallback)).toEqual({
      background: '#ffffff',
      symbol: '#000000',
    })
  })
})
