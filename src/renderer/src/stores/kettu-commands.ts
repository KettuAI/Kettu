import { create } from 'zustand'
import type { KettuCommand } from '@shared/agent-host'
import { hostAt } from '@renderer/lib/host'

interface KettuCommandsStore {
  /** Each host's commands of Kettu's, by host id, '' for this computer. */
  byHost: Record<string, KettuCommand[]>
}

const NONE: KettuCommand[] = []

/** The commands of Kettu's that each host's plugins and its user's own folder hold. */
export const useKettuCommandsStore = create<KettuCommandsStore>()(() => ({ byHost: {} }))

const keyOf = (hostId: string | null): string => hostId ?? ''

/** The host's commands, null being this computer; empty until they are read. */
export function useKettuCommands(hostId: string | null): KettuCommand[] {
  return useKettuCommandsStore((s) => s.byHost[keyOf(hostId)] ?? NONE)
}

const reading = new Map<string, Promise<void>>()

/**
 * Reads a host's commands again. A host that does not know the request, as an older one does, has
 * none to list.
 */
export function loadKettuCommands(hostId: string | null): Promise<void> {
  const key = keyOf(hostId)
  const running = reading.get(key)
  if (running) return running
  const read = hostAt(hostId, 'commands.list', undefined)
    .then(
      ({ commands }) => commands,
      () => NONE,
    )
    .then((commands) => {
      useKettuCommandsStore.setState((s) => ({ byHost: { ...s.byHost, [key]: commands } }))
    })
    .finally(() => reading.delete(key))
  reading.set(key, read)
  return read
}
