// The web client's settings: only this device's, kept in this browser. The host's own settings,
// its agents, remote access and the rest, are the host's and stay there.

import { DEFAULT_SETTINGS, type SettingsFile, type SettingsPatch } from '@shared/settings'

const KEY = 'kettu.settings'

/** The sections a browser keeps; the rest of a patch is the host's and is dropped. */
const DEVICE_SECTIONS = ['general', 'thread', 'appearance', 'terminal'] as const

type DeviceSection = (typeof DEVICE_SECTIONS)[number]

export class WebSettings {
  private current: SettingsFile
  private readonly listeners = new Set<(settings: SettingsFile) => void>()

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.current = merge(DEFAULT_SETTINGS, read(storage))
  }

  get(): SettingsFile {
    return this.current
  }

  update(patch: SettingsPatch): SettingsFile {
    this.current = merge(this.current, patch)
    try {
      this.storage?.setItem(KEY, JSON.stringify(pick(this.current)))
    } catch {
      // Private browsing or a full quota: the change holds until the page closes.
    }
    for (const listener of this.listeners) listener(this.current)
    return this.current
  }

  onChanged(listener: (settings: SettingsFile) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

function read(storage: Pick<Storage, 'getItem'> | null): SettingsPatch {
  try {
    const value: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null')
    return typeof value === 'object' && value !== null ? (value as SettingsPatch) : {}
  } catch {
    return {}
  }
}

function pick(settings: SettingsFile): Pick<SettingsFile, DeviceSection> {
  return Object.fromEntries(DEVICE_SECTIONS.map((section) => [section, settings[section]])) as Pick<
    SettingsFile,
    DeviceSection
  >
}

/**
 * `patch` over `settings`, section by section, each value kept only where it has the type the
 * default has, since what was stored may come from an older build.
 */
function merge(settings: SettingsFile, patch: SettingsPatch): SettingsFile {
  const next = { ...settings }
  for (const section of DEVICE_SECTIONS) {
    const given = (patch as Record<string, unknown>)[section]
    if (typeof given !== 'object' || given === null) continue
    const defaults = DEFAULT_SETTINGS[section] as Record<string, unknown>
    const merged: Record<string, unknown> = { ...settings[section] }
    for (const [key, value] of Object.entries(given)) {
      if (!Object.hasOwn(defaults, key)) continue
      const fallback = defaults[key]
      // A null default, as the default agent's, takes an id in its place.
      if (fallback === null) {
        if (value === null || typeof value === 'string') merged[key] = value
      } else if (typeof value === typeof fallback) merged[key] = value
    }
    ;(next as Record<string, unknown>)[section] = merged
  }
  return next
}
