// The SOP library and its settings, per host: what New session's tray, the Marketplace and
// Settings show. Read on demand and again when the host says the library changed.

import { create } from 'zustand'
import type { SopEntry, SopSettings } from '@shared/sop'
import { errorMessage, hostAt } from '@renderer/lib/host'

/** A host's key in the store: its id, or '' for this computer. */
export function sopsKey(hostId: string | null): string {
  return hostId ?? ''
}

interface HostSops {
  entries: SopEntry[]
  settings: SopSettings | null
  loaded: boolean
  error: string | null
}

const EMPTY: HostSops = { entries: [], settings: null, loaded: false, error: null }

/** Hosts whose first read is under way, so a render does not start another. */
const reading = new Set<string>()

interface SopsStore {
  byHost: Record<string, HostSops>
  load(hostId: string | null): Promise<void>
  /** The host's library changed: read again what was read before. */
  changed(hostId: string | null): void
}

export const useSopsStore = create<SopsStore>()((set, get) => ({
  byHost: {},
  async load(hostId) {
    const key = sopsKey(hostId)
    try {
      const [entries, settings] = await Promise.all([
        hostAt(hostId, 'sops.list', undefined),
        hostAt(hostId, 'sops.settings', undefined),
      ])
      set((state) => ({
        byHost: { ...state.byHost, [key]: { entries, settings, loaded: true, error: null } },
      }))
    } catch (error) {
      set((state) => ({
        byHost: {
          ...state.byHost,
          [key]: { ...(state.byHost[key] ?? EMPTY), loaded: true, error: errorMessage(error) },
        },
      }))
    }
  },
  changed(hostId) {
    if (get().byHost[sopsKey(hostId)]) void get().load(hostId)
  },
}))

/** The host's SOPs as last read; reads them the first time. */
export function useHostSops(hostId: string | null): HostSops {
  const key = sopsKey(hostId)
  const own = useSopsStore((state) => state.byHost[key])
  if (!own && !reading.has(key)) {
    reading.add(key)
    queueMicrotask(
      () =>
        void useSopsStore
          .getState()
          .load(hostId)
          .finally(() => reading.delete(key)),
    )
  }
  return own ?? EMPTY
}
