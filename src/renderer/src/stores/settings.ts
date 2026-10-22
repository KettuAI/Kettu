import { create } from 'zustand'
import { DEFAULT_SETTINGS, type SettingsFile, type SettingsPatch } from '@shared/settings'
import { applyLanguage } from '@renderer/lib/i18n'

interface SettingsStore {
  settings: SettingsFile
  loaded: boolean
  update(patch: SettingsPatch): Promise<void>
}

export const useSettingsStore = create<SettingsStore>()(() => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  async update(patch) {
    const settings = await window.overbench.settings.update(patch)
    useSettingsStore.setState({ settings })
  },
}))

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

function applyAppearance(settings: SettingsFile): void {
  const root = document.documentElement
  const { theme, textSize, reduceMotion, zoom } = settings.appearance
  const dark = theme === 'dark' || (theme === 'system' && darkQuery.matches)
  root.classList.toggle('dark', dark)
  root.dataset.theme = dark ? 'dark' : 'light'
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
  darkQuery.addEventListener('change', () => applyAppearance(useSettingsStore.getState().settings))
  useSettingsStore.subscribe((state, previous) => {
    if (state.settings.appearance !== previous.settings.appearance) applyAppearance(state.settings)
    if (state.settings.general.language !== previous.settings.general.language) {
      applyLanguage(state.settings.general.language)
    }
  })
  window.overbench.settings.onChanged((settings) => useSettingsStore.setState({ settings }))
  const settings = await window.overbench.settings.get()
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
