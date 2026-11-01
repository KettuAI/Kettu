// The web client's settings. What takes effect on the host is the host's: read from it once
// connected, followed through its events and written there. The rest is this browser's own and
// stays in its localStorage, as a window's would stay with that window.

import {
  HOST_SETTING_KEYS,
  splitSettingsPatch,
  withHostSettings,
  type HostAdminEvent,
  type HostSettingsPart,
} from '@shared/remote/host-admin'
import { DEFAULT_SETTINGS, type SettingsFile, type SettingsPatch } from '@shared/settings'
import type { LinkState } from './link'

const KEY = 'kettu.settings'

/** How long the first read waits for the host's part before it answers with the defaults. */
export const HOST_WAIT_MS = 3000

/** What the settings take from the channel: a `HostLink`, or a test's own. */
export interface SettingsLink {
  request(method: string, params: unknown): Promise<unknown>
  onAdminEvent(listener: (event: HostAdminEvent) => void): () => void
  onState(listener: (state: LinkState) => void): () => void
}

type Section = Exclude<keyof SettingsFile, 'version'>

/** The keys this browser keeps, by section: every key the host does not take. */
const CLIENT_KEYS: Partial<Record<Section, readonly string[]>> = Object.fromEntries(
  (Object.keys(DEFAULT_SETTINGS) as (keyof SettingsFile)[]).flatMap((section) => {
    if (section === 'version') return []
    const host = (HOST_SETTING_KEYS as Partial<Record<Section, 'all' | readonly string[]>>)[section]
    if (host === 'all') return []
    const keys = Object.keys(DEFAULT_SETTINGS[section]).filter((key) => !host?.includes(key))
    return keys.length > 0 ? [[section, keys]] : []
  }),
)

export class WebSettings {
  /** This browser's part, over the defaults; the host's keys stay at theirs. */
  private client: SettingsFile
  private host: HostSettingsPart | null = null
  private link: SettingsLink | null = null
  /** Whether a read stops waiting for the host's part: it came, failed, or was waited for. */
  private settled = false
  private readonly waiters: (() => void)[] = []
  private readonly listeners = new Set<(settings: SettingsFile) => void>()

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null,
    private readonly wait = HOST_WAIT_MS,
  ) {
    this.client = merge(DEFAULT_SETTINGS, read(storage))
  }

  /**
   * Takes the host's part over `link` from now on: read at each connection, since changes made
   * while away are not sent again, and followed through the host's events in between.
   */
  attach(link: SettingsLink): void {
    if (this.link) return
    this.link = link
    link.onAdminEvent((event) => {
      if (event.type === 'settings.changed') this.takeHost(event.settings)
    })
    link.onState((state) => {
      if (state.kind === 'connected') void this.read(link)
      else if (state.kind === 'stopped') this.settle()
    })
  }

  /**
   * The whole file. Once connected to a host, the first read waits a while for the host's part
   * and then answers with what it has; a part that comes later is told to `onChanged`.
   */
  async get(): Promise<SettingsFile> {
    if (this.link && !this.settled) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => this.settle(), this.wait)
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    return this.current()
  }

  /** The file as it stands now, with the defaults for the host's part until it comes. */
  current(): SettingsFile {
    return this.host ? withHostSettings(this.client, this.host) : this.client
  }

  /**
   * Writes the host's part of `patch` on the host first, and only once it took it, this
   * browser's part, so a refused change leaves nothing half done.
   */
  async update(patch: SettingsPatch): Promise<SettingsFile> {
    const { host, client } = splitSettingsPatch(patch)
    if (host) {
      if (!this.link) throw new Error('This page is not connected to the host')
      this.host = (await this.link.request('settings.update', { patch: host })) as HostSettingsPart
      this.settle()
    }
    if (client) {
      this.client = merge(this.client, client)
      try {
        this.storage?.setItem(KEY, JSON.stringify(clientPart(this.client)))
      } catch {
        // Private browsing or a full quota: the change holds until the page closes.
      }
    }
    return this.changed()
  }

  /** The host's part as a call answered it, such as choosing a program there. */
  takeHost(part: HostSettingsPart): void {
    const same = this.host !== null && JSON.stringify(this.host) === JSON.stringify(part)
    this.host = part
    this.settle()
    if (!same) this.changed()
  }

  onChanged(listener: (settings: SettingsFile) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async read(link: SettingsLink): Promise<void> {
    try {
      this.takeHost((await link.request('settings.get', undefined)) as HostSettingsPart)
    } catch (error) {
      console.error("Could not read the host's settings", error)
      this.settle()
    }
  }

  private settle(): void {
    this.settled = true
    for (const done of this.waiters.splice(0)) done()
  }

  private changed(): SettingsFile {
    const file = this.current()
    for (const listener of this.listeners) listener(file)
    return file
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

/** What this browser stores: its own keys of each section. */
function clientPart(settings: SettingsFile): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(CLIENT_KEYS).map(([section, keys]) => {
      const values = settings[section as Section] as Record<string, unknown>
      return [
        section,
        Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, values[k]])),
      ]
    }),
  )
}

/**
 * `patch` over `settings` for this browser's keys, each value kept only where it has the type
 * the default has, since what was stored may come from an older build.
 */
function merge(settings: SettingsFile, patch: SettingsPatch): SettingsFile {
  const next = { ...settings }
  for (const [section, keys] of Object.entries(CLIENT_KEYS) as [Section, readonly string[]][]) {
    const given = (patch as Record<string, unknown>)[section]
    if (typeof given !== 'object' || given === null) continue
    const defaults = DEFAULT_SETTINGS[section] as Record<string, unknown>
    const merged: Record<string, unknown> = { ...settings[section] }
    for (const [key, value] of Object.entries(given)) {
      if (!keys.includes(key)) continue
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
