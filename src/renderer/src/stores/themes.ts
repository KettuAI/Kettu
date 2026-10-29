import { create } from 'zustand'
import { BUILTIN_THEME_ID, type Theme, type ThemesState } from '@shared/themes'
import { applyThemeStyle } from '@renderer/lib/theme-style'

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
