import { create } from 'zustand'

interface MemoryStore {
  /** How many times each host's memory or its switch changed, by host id, '' for this computer. */
  changes: Record<string, number>
  /** The project Settings › Memory shows, as its host writes the path, by host id. */
  project: Record<string, string>
}

/** Kettu's memory as the window follows it: a page that shows a host's reads again on a change. */
export const useMemoryStore = create<MemoryStore>()(() => ({ changes: {}, project: {} }))

const keyOf = (hostId: string | null): string => hostId ?? ''

/** A host's memory changed, null being this computer. */
export function memoryChanged(hostId: string | null): void {
  const key = keyOf(hostId)
  useMemoryStore.setState((s) => ({
    changes: { ...s.changes, [key]: (s.changes[key] ?? 0) + 1 },
  }))
}

/** A count that moves on every change of the host's memory, for a read to depend on. */
export function useMemoryChanges(hostId: string | null): number {
  return useMemoryStore((s) => s.changes[keyOf(hostId)] ?? 0)
}

/** The project Settings › Memory shows for the host, null until one is chosen. */
export function useMemoryProject(hostId: string | null): string | null {
  return useMemoryStore((s) => s.project[keyOf(hostId)] ?? null)
}

export function chooseMemoryProject(hostId: string | null, project: string): void {
  const key = keyOf(hostId)
  useMemoryStore.setState((s) =>
    s.project[key] === project ? s : { project: { ...s.project, [key]: project } },
  )
}
