import { create } from 'zustand'
import { DEFAULT_SETTINGS, type SettingsFile, type SettingsPatch } from '@shared/settings'
import { showColorMode } from '@renderer/lib/color-mode'
import { applyLanguage } from '@renderer/lib/i18n'

export interface SettingsStore {
  settings: SettingsFile
  loaded: boolean
  update(patch: SettingsPatch): Promise<void>
}

export const useSettingsStore = create<SettingsStore>()(() => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  async update(patch) {
    const settings = await window.kettu.settings.update(patch)
    useSettingsStore.setState({ settings })
  },
}))

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

function applyAppearance(settings: SettingsFile, fade = false): void {
  const root = document.documentElement
  const { theme, textSize, reduceMotion, zoom } = settings.appearance
  const dark = theme === 'dark' || (theme === 'system' && darkQuery.matches)
  showColorMode(dark ? 'dark' : 'light', fade)
  root.dataset.textSize = textSize
  root.dataset.reduceMotion = reduceMotion
  root.style.setProperty('--zoom', String(zoom))
}

/**
 * Loads the settings, applies appearance as attributes on <html> and the language, and follows
 * every change.
 */
export async function initSettings(): Promise<void> {
  applyAppearance(DEFAULT_SETTINGS)
  darkQuery.addEventListener('change', () => {
    const { settings, loaded } = useSettingsStore.getState()
    applyAppearance(settings, loaded)
  })
  useSettingsStore.subscribe((state, previous) => {
    // The settings read at launch replace the defaults at once; later changes fade.
    if (state.settings.appearance !== previous.settings.appearance) {
      applyAppearance(state.settings, previous.loaded)
    }
    if (state.settings.general.language !== previous.settings.general.language) {
      applyLanguage(state.settings.general.language)
    }
  })
  window.kettu.settings.onChanged((settings) => useSettingsStore.setState({ settings }))
  const settings = await window.kettu.settings.get()
  useSettingsStore.setState({ settings, loaded: true })
  applyAppearance(settings)
  applyLanguage(settings.general.language)
}

/** Whether motion is reduced right now, from the setting or the OS. */
export function prefersReducedMotion(): boolean {
  return (
    useSettingsStore.getState().settings.appearance.reduceMotion === 'always' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
