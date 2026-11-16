// What idle Claude Code sessions follow on each host, for Settings › Agents › Idle sessions: read
// the first time the block shows, then kept current by the host's `idleRelease.changed`.

import { create } from 'zustand'
import type { IdleReleaseState } from '@shared/idle-release'
import { errorMessage, hostAt } from '@renderer/lib/host'

/** A host's key in the store: its id, or '' for this computer. */
const keyOf = (hostId: string | null): string => hostId ?? ''

interface IdleReleaseStore {
  /** Null for a host that cannot say, such as one older than the setting. */
  byHost: Record<string, IdleReleaseState | null>
  load(hostId: string | null): Promise<void>
  receive(hostId: string | null, state: IdleReleaseState): void
  /** The host started again, losing what it knew: what was read before is read again. */
  reload(hostId: string | null): void
}

const reading = new Set<string>()

export const useIdleReleaseStore = create<IdleReleaseStore>()((set, get) => ({
  byHost: {},
  async load(hostId) {
    const key = keyOf(hostId)
    let state: IdleReleaseState | null = null
    try {
      state = await hostAt(hostId, 'sessions.idleRelease', undefined)
    } catch (error) {
      // The block leaves out what the host cannot say, as a host older than the setting.
      console.warn(`Could not read the idle sessions' rule: ${errorMessage(error)}`)
    }
    set((store) => ({ byHost: { ...store.byHost, [key]: state } }))
  },
  receive(hostId, state) {
    set((store) => ({ byHost: { ...store.byHost, [keyOf(hostId)]: state } }))
  },
  reload(hostId) {
    if (get().byHost[keyOf(hostId)] !== undefined) void get().load(hostId)
  },
}))

/** The host's idle rule as last heard; undefined until the first read answers. */
export function useIdleRelease(hostId: string | null): IdleReleaseState | null | undefined {
  const key = keyOf(hostId)
  const state = useIdleReleaseStore((store) => store.byHost[key])
  if (state === undefined && !reading.has(key)) {
    reading.add(key)
    queueMicrotask(
      () =>
        void useIdleReleaseStore
          .getState()
          .load(hostId)
          .finally(() => reading.delete(key)),
    )
  }
  return state
}
