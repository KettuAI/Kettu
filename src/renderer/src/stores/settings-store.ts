import { create } from 'zustand'
import { DEFAULT_SETTINGS, type SettingsFile, type SettingsPatch } from '@shared/settings'

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
