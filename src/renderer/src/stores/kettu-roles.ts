import { create } from 'zustand'
import type { KettuRole } from '@shared/agent-host'
import { hostAt } from '@renderer/lib/host'

interface KettuRolesStore {
  /** Each host's roles, by host id, '' for this computer. */
  byHost: Record<string, KettuRole[]>
}

const NONE: KettuRole[] = []

/** The roles that each host's plugins and its user's own folder hold. */
export const useKettuRolesStore = create<KettuRolesStore>()(() => ({ byHost: {} }))

const keyOf = (hostId: string | null): string => hostId ?? ''

/** The host's roles, null being this computer; empty until they are read. */
export function useKettuRoles(hostId: string | null): KettuRole[] {
  return useKettuRolesStore((s) => s.byHost[keyOf(hostId)] ?? NONE)
}

const reading = new Map<string, Promise<void>>()

/**
 * Reads a host's roles again. A host that does not know the request, as an older one does, has
 * none to list.
 */
export function loadKettuRoles(hostId: string | null): Promise<void> {
  const key = keyOf(hostId)
  const running = reading.get(key)
  if (running) return running
  const read = hostAt(hostId, 'roles.list', undefined)
    .then(
      ({ roles }) => roles,
      () => NONE,
    )
    .then((roles) => {
      useKettuRolesStore.setState((s) => ({ byHost: { ...s.byHost, [key]: roles } }))
    })
    .finally(() => reading.delete(key))
  reading.set(key, read)
  return read
}
