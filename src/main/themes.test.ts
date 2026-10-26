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

const { readThemeFolder, themeId, ThemeStore, windowColors } = await import('./themes')

const WINDOW = {} as Electron.BrowserWindow

const theme = (name: string, dark: Record<string, string> = { 'bg-app': '#2e3440' }) =>
  JSON.stringify({ overbenchTheme: 1, name, light: {}, dark: { colors: dark } })

let dir: string
let themesDir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'overbench-themes-'))
  themesDir = path.join(dir, 'themes')
  await mkdir(themesDir)
  vi.clearAllMocks()
})

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
    await put('themes/overbench.json', theme('Over'))
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

  async function store(chosen = 'overbench') {
    const themes: InstanceType<typeof ThemeStore> = new ThemeStore(
      await readThemeFolder(themesDir),
      chosen,
      // As settings.json does: the setting changes, and its listener tells the store.
      { dir: themesDir, select: (id) => themes.choose(id), changed },
    )
    return themes
  }

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

    expect(await themes.install(WINDOW)).toEqual({
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
    expect(await themes.install(null)).toEqual({
      status: 'failed',
      file: 'x.json',
      error: { code: 'invalid-color', path: 'dark.colors.bg-app' },
    })
    chooseFile(path.join(dir, 'gone.json'))
    expect(await themes.install(null)).toEqual({
      status: 'failed',
      file: 'gone.json',
      error: { code: 'unreadable' },
    })
    chooseFile(null)
    expect(await themes.install(null)).toEqual({ status: 'cancelled' })
    expect(await readdir(themesDir)).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })

  it('asks before it replaces an installed theme, and replaces it on the token', async () => {
    await put('themes/nord.json', theme('Nord'))
    const newer = theme('NORD', { 'bg-app': '#242933' })
    chooseFile(await put('downloads/nord.json', newer))
    const themes = await store('nord')

    const answer = await themes.install(null)
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

  it('removes a theme, and brings back the built-in one for the chosen theme', async () => {
    await put('themes/nord.json', theme('Nord'))
    await put('themes/ayu.json', theme('Ayu'))
    const themes = await store('nord')

    await themes.remove('ayu')
    expect(themes.state()).toMatchObject({ chosen: 'nord', failed: null })
    await themes.remove('nord')
    expect(themes.state()).toEqual({ installed: [], chosen: 'overbench', failed: null })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(changed.mock.calls[1]![1]).toBeNull()
    expect(await readdir(themesDir)).toEqual([])
  })

  it('refuses ids it does not hold', async () => {
    await put('settings.json', '{}')
    const themes = await store()
    for (const id of ['../settings', 'nord', 'overbench', 7]) {
      await expect(themes.remove(id)).rejects.toThrow('Not an installed theme')
      expect(() => themes.reveal(id)).toThrow('Not an installed theme')
    }
    expect(await readFile(path.join(dir, 'settings.json'), 'utf8')).toBe('{}')
  })

  it('reveals a theme file, a broken one too', async () => {
    await put('themes/broken.json', '{')
    ;(await store()).reveal('broken')
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
    expect(await themes.export(WINDOW, source)).toBe(true)
    expect(await readFile(target, 'utf8')).toBe(source)
    expect(electron.save).toHaveBeenCalledWith(WINDOW, {
      title: 'Export Theme',
      defaultPath: path.join('/downloads', 'My Theme.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })

    electron.save.mockResolvedValue({ canceled: true, filePath: '' })
    expect(await themes.export(null, source)).toBe(false)
    await expect(themes.export(null, '{"name": "x"}')).rejects.toThrow('Not a theme file')
    await expect(themes.export(null, 5)).rejects.toThrow('must be text')
    expect(electron.save).toHaveBeenCalledTimes(2)
  })
})

describe('windowColors', () => {
  const fallback = { background: '#ffffff', symbol: '#262626' }

  it("takes the variant's background and text as hex", () => {
    expect(
      windowColors({ 'bg-app': '#2E3440', 'text-primary': 'rgb(236 239 244)' }, 'dark', fallback),
    ).toEqual({ background: '#2e3440', symbol: '#eceff4' })
  })

  it('lays a translucent background over white or black, and the text over the background', () => {
    const colors = { 'bg-app': 'rgb(255 255 255 / 50%)', 'text-primary': 'rgb(0 0 0 / 50%)' }
    expect(windowColors(colors, 'dark', fallback)).toEqual({
      background: '#808080',
      symbol: '#404040',
    })
    expect(windowColors({ 'bg-app': 'transparent' }, 'light', fallback).background).toBe('#ffffff')
  })

  it('keeps the fallback for what the theme leaves out', () => {
    expect(windowColors({}, 'light', fallback)).toEqual(fallback)
    expect(windowColors({ 'text-primary': '#000' }, 'light', fallback)).toEqual({
      background: '#ffffff',
      symbol: '#000000',
    })
  })
})
