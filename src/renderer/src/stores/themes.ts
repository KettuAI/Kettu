import { create } from 'zustand'
import { pluginOfTheme } from '@shared/plugin-themes'
import { BUILTIN_THEME_ID, type Theme, type ThemesState } from '@shared/themes'
import { hostAt } from '@renderer/lib/host'
import { applyThemeStyle } from '@renderer/lib/theme-style'
import { useSettingsStore } from './settings'

interface ThemesStore {
  state: ThemesState
  /** The theme that shows: the chosen one, or null while the built-in one does. */
  shown: Theme | null
}

export const useThemesStore = create<ThemesStore>()(() => ({
  state: { installed: [], chosen: BUILTIN_THEME_ID, failed: null },
  shown: null,
}))

/** Takes main's answer; the shown theme's colors are written before anyone is told. */
export function receiveThemes(state: ThemesState): void {
  const chosen = state.failed ? undefined : state.installed.find(({ id }) => id === state.chosen)
  const next = chosen?.theme ?? null
  const { shown } = useThemesStore.getState()
  // Main's answers are new objects each time; a theme that stays the same keeps its own.
  const same = JSON.stringify(next) === JSON.stringify(shown)
  if (!same) applyThemeStyle(next)
  useThemesStore.setState({ state, shown: same ? shown : next })
}

/**
 * A plugin's theme that cannot show stays chosen while its plugin is installed, so turning the
 * plugin off only shows the built-in theme until it is on again. Once the plugin is uninstalled the
 * built-in theme takes its place for good, as it does when the chosen theme is removed. A host that
 * cannot say keeps the choice.
 */
export async function leaveUninstalledPluginTheme(): Promise<void> {
  const { chosen, failed } = useThemesStore.getState().state
  const pluginId = failed?.id === chosen ? pluginOfTheme(chosen) : null
  if (pluginId === null) return
  const gone = await hostAt(null, 'plugins.list', undefined).then(
    ({ plugins }) => !plugins.some(({ id }) => id === pluginId),
    () => false,
  )
  const now = useThemesStore.getState().state
  if (!gone || now.chosen !== chosen || now.failed?.id !== chosen) return
  await useSettingsStore
    .getState()
    .update({ appearance: { colorTheme: BUILTIN_THEME_ID } })
    .catch((error: unknown) => console.error("Could not leave a plugin's theme", error))
}

/** The main window's part: every new list is checked for a plugin's theme left behind. */
export function followUninstalledPluginThemes(): void {
  useThemesStore.subscribe((s, previous) => {
    if (s.state !== previous.state) void leaveUninstalledPluginTheme()
  })
}

/** Loads the themes and follows every change; the first render waits for it. */
export async function initThemes(): Promise<void> {
  window.kettu.themes.onChanged(receiveThemes)
  receiveThemes(await window.kettu.themes.get())
}

/**
 * Calls `listener` once the colors the tokens give may have changed: another color mode on
 * <html>, or another theme. For code that takes colors as values, such as xterm.js.
 */
export function onColorsChange(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const unsubscribe = useThemesStore.subscribe((state, previous) => {
    if (state.shown !== previous.shown) listener()
  })
  return () => {
    observer.disconnect()
    unsubscribe()
  }
}
