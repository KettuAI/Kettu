import { describe, expect, it, vi } from 'vitest'
import type { HostThemes } from '@shared/remote/host-admin'
import type { InstalledTheme, ThemesState } from '@shared/themes'
import { WebSettings } from './settings'
import { themesState, webThemes, type AdminCall } from './themes'

const nord: InstalledTheme = {
  id: 'nord',
  theme: { kettuTheme: 1, name: 'Nord', light: {}, dark: {} } as unknown as InstalledTheme['theme'],
  ignored: [],
}
const HOST: HostThemes = {
  installed: [nord],
  failed: [{ id: 'broken', failure: { code: 'invalid', error: { code: 'not-json' } } }],
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
  }
}

function setup(answers: Record<string, unknown> = {}, storage = memoryStorage()) {
  const settings = new WebSettings(null)
  const calls: [string, unknown][] = []
  const admin = vi.fn(async (method: string, params?: unknown) => {
    calls.push([method, params])
    if (!(method in answers)) throw new Error(`No answer for ${method}`)
    return answers[method]
  }) as unknown as AdminCall
  let hostChanged: (themes: HostThemes) => void = () => {}
  let connected: () => void = () => {}
  const picked: { file: File | null } = { file: null }
  const downloads: [Blob, string][] = []
  const copied: string[] = []
  const themes = webThemes({
    admin,
    onHostChanged: (listener) => {
      hostChanged = listener
      return () => {}
    },
    onConnected: (listener) => {
      connected = listener
      return () => {}
    },
    settings,
    storage,
    pickFile: async () => picked.file,
    download: (blob, name) => void downloads.push([blob, name]),
    copyPath: async (path) => void copied.push(path),
  })
  const states: ThemesState[] = []
  themes.onChanged((state) => states.push(state))
  return {
    themes,
    settings,
    calls,
    picked,
    downloads,
    copied,
    states,
    storage,
    hostChanged: (next: HostThemes) => hostChanged(next),
    connected: () => connected(),
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the web client's themes", () => {
  it("shows the host's themes with the one this browser chose, and why that one fails", () => {
    expect(themesState(HOST, 'kettu')).toEqual({ installed: [nord], chosen: 'kettu', failed: null })
    expect(themesState(HOST, 'nord').failed).toBeNull()
    expect(themesState(HOST, 'broken').failed).toEqual({
      id: 'broken',
      failure: { code: 'invalid', error: { code: 'not-json' } },
    })
    expect(themesState(HOST, 'gone').failed).toEqual({ id: 'gone', failure: { code: 'missing' } })
  })

  it("reads the host's list at each connection, and follows it and this browser's choice", async () => {
    const t = setup({ 'themes.get': HOST })
    t.connected()
    await flush()
    expect(t.states.at(-1)).toEqual({ installed: [nord], chosen: 'kettu', failed: null })
    await t.settings.update({ appearance: { colorTheme: 'nord' } })
    expect(t.states.at(-1)?.chosen).toBe('nord')
    t.hostChanged({ installed: [], failed: [] })
    expect(t.states.at(-1)).toEqual({
      installed: [],
      chosen: 'nord',
      failed: { id: 'nord', failure: { code: 'missing' } },
    })
  })

  it('answers at once from the list it kept, so a reload shows its theme before the host answers', async () => {
    const storage = memoryStorage()
    const first = setup({ 'themes.get': HOST }, storage)
    first.connected()
    await flush()
    const again = setup({}, storage)
    expect((await again.themes.get()).installed).toEqual([nord])
  })

  it('installs a file this browser picked on the host, and shows it here', async () => {
    const answer = { status: 'installed', id: 'nord', ignored: [], show: true }
    const t = setup({ 'themes.add': answer })
    t.picked.file = new File(['{"kettuTheme":1}'], 'nord.json')
    expect(await t.themes.install()).toEqual(answer)
    expect(t.calls).toEqual([['themes.add', { file: 'nord.json', text: '{"kettuTheme":1}' }]])
    expect(t.settings.current().appearance.colorTheme).toBe('nord')
  })

  it('refuses a file it cannot send, and sends nothing when the user cancels', async () => {
    const t = setup()
    expect(await t.themes.install()).toEqual({ status: 'cancelled' })
    t.picked.file = new File([new Uint8Array([0x7b, 0xe9, 0x7d])], 'latin1.json')
    expect(await t.themes.install()).toEqual({
      status: 'failed',
      file: 'latin1.json',
      error: { code: 'not-json' },
    })
    t.picked.file = new File([' '.repeat(256 * 1024 + 1)], 'big.json')
    expect(await t.themes.install()).toEqual({
      status: 'failed',
      file: 'big.json',
      error: { code: 'too-large' },
    })
    expect(t.calls).toEqual([])
  })

  it('keeps showing its theme after a catalog update the host does not show', async () => {
    const t = setup({
      'themes.installCatalog': { status: 'installed', id: 'nord', ignored: [], show: false },
    })
    await t.themes.installCatalog('nord')
    expect(t.settings.current().appearance.colorTheme).toBe('kettu')
  })

  it('brings back the built-in theme here when the one it shows is removed', async () => {
    const t = setup({ 'themes.remove': null })
    await t.settings.update({ appearance: { colorTheme: 'nord' } })
    await t.themes.remove('nord')
    expect(t.calls).toEqual([['themes.remove', { id: 'nord' }]])
    expect(t.settings.current().appearance.colorTheme).toBe('kettu')
  })

  it('downloads an export and copies a theme file path on the host', async () => {
    const t = setup({ 'themes.path': '/srv/kettu/themes/nord.json' })
    const text = JSON.stringify({ kettuTheme: 1, name: 'Nord: Frost', light: {}, dark: {} })
    expect(await t.themes.export(text)).toBeNull()
    expect(t.downloads.map(([, name]) => name)).toEqual(['Nord- Frost.json'])
    await expect(t.themes.export('{}')).rejects.toThrow('Not a theme file')
    await t.themes.reveal('nord')
    expect(t.copied).toEqual(['/srv/kettu/themes/nord.json'])
  })
})
