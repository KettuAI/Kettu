import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledTheme, ThemesState } from '@shared/themes'

const style = { textContent: '' }
const attributes = new Map<string, string>()
const observed: { callback: () => void; options: MutationObserverInit }[] = []
vi.stubGlobal('document', {
  documentElement: {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  },
  head: { append: () => {} },
  createElement: () => style,
})
vi.stubGlobal(
  'MutationObserver',
  class {
    constructor(private readonly callback: () => void) {}
    observe(_: unknown, options: MutationObserverInit) {
      observed.push({ callback: this.callback, options })
    }
    disconnect() {}
  },
)

const { onColorsChange, receiveThemes, useThemesStore } = await import('./themes')

const nord: InstalledTheme = {
  id: 'nord',
  theme: { name: 'Nord', light: { colors: {} }, dark: { colors: { 'bg-app': '#2e3440' } } },
  ignored: [],
}
const ayu: InstalledTheme = {
  id: 'ayu',
  theme: {
    name: 'Ayu',
    fonts: { prose: 'source-serif-4' },
    light: { colors: { 'bg-app': '#fcfcfc' } },
    dark: { colors: {} },
  },
  ignored: [],
}
const state = (chosen: string, installed = [ayu, nord]): ThemesState => ({
  installed,
  chosen,
  failed: null,
})

beforeEach(() => receiveThemes(state('kettu')))

describe('receiveThemes', () => {
  it('writes the chosen theme before it tells anyone', () => {
    const seen: string[] = []
    const stop = useThemesStore.subscribe(() => seen.push(style.textContent))
    receiveThemes(state('nord'))
    stop()
    expect(seen).toEqual([expect.stringContaining('--bg-app: #2e3440;')])
    expect(useThemesStore.getState().shown?.name).toBe('Nord')
  })

  it('shows the built-in theme while the chosen one fails to load', () => {
    receiveThemes(state('nord'))
    receiveThemes({ ...state('nord'), failed: { id: 'nord', failure: { code: 'missing' } } })
    expect(useThemesStore.getState().shown).toBeNull()
    expect(style.textContent).toBe('')
  })

  it("sets the chosen theme's faces on <html>, and clears them for the built-in theme", () => {
    receiveThemes(state('ayu'))
    expect([...attributes]).toEqual([['data-font-prose', 'source-serif-4']])
    receiveThemes(state('kettu'))
    expect(attributes.size).toBe(0)
  })

  it('keeps the shown theme while only the list around it changes', () => {
    receiveThemes(state('nord'))
    const { shown } = useThemesStore.getState()
    receiveThemes(state('nord', [nord]))
    expect(useThemesStore.getState().shown).toBe(shown)
  })
})

describe('onColorsChange', () => {
  it('follows the color mode on <html> and the theme, not the list of themes', () => {
    const listener = vi.fn()
    const stop = onColorsChange(listener)
    const { callback, options } = observed.at(-1)!
    expect(options).toEqual({ attributes: true, attributeFilter: ['data-theme'] })

    callback()
    expect(listener).toHaveBeenCalledTimes(1)
    receiveThemes(state('kettu', [nord]))
    expect(listener).toHaveBeenCalledTimes(1)
    receiveThemes(state('ayu'))
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    receiveThemes(state('nord'))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
