// The workflow library and its settings, per host: what New session's tray, the Marketplace and
// Settings show. Read on demand and again when the host says the library changed.

import { create } from 'zustand'
import type { WireWorkflowEntry, WorkflowSettings } from '@shared/workflow'
import { errorMessage, hostAt } from '@renderer/lib/host'

/** A host's key in the store: its id, or '' for this computer. */
export function workflowsKey(hostId: string | null): string {
  return hostId ?? ''
}

interface HostWorkflows {
  entries: WireWorkflowEntry[]
  settings: WorkflowSettings | null
  loaded: boolean
  error: string | null
}

const EMPTY: HostWorkflows = { entries: [], settings: null, loaded: false, error: null }

/** Hosts whose first read is under way, so a render does not start another. */
const reading = new Set<string>()

/** Each host's latest read, so an older one that answers late changes nothing. */
const latest = new Map<string, number>()

interface WorkflowsStore {
  byHost: Record<string, HostWorkflows>
  load(hostId: string | null): Promise<void>
  /** The host's library changed: read again what was read before. */
  changed(hostId: string | null): void
}

export const useWorkflowsStore = create<WorkflowsStore>()((set, get) => ({
  byHost: {},
  async load(hostId) {
    const key = workflowsKey(hostId)
    const read = (latest.get(key) ?? 0) + 1
    latest.set(key, read)
    try {
      const [entries, settings] = await Promise.all([
        hostAt(hostId, 'workflows.list', undefined),
        hostAt(hostId, 'workflows.settings', undefined),
      ])
      if (latest.get(key) !== read) return
      set((state) => ({
        byHost: { ...state.byHost, [key]: { entries, settings, loaded: true, error: null } },
      }))
    } catch (error) {
      if (latest.get(key) !== read) return
      set((state) => ({
        byHost: {
          ...state.byHost,
          [key]: { ...(state.byHost[key] ?? EMPTY), loaded: true, error: errorMessage(error) },
        },
      }))
    }
  },
  changed(hostId) {
    if (get().byHost[workflowsKey(hostId)]) void get().load(hostId)
  },
}))

/** The host's workflows as last read; reads them the first time. */
export function useHostWorkflows(hostId: string | null): HostWorkflows {
  const key = workflowsKey(hostId)
  const own = useWorkflowsStore((state) => state.byHost[key])
  if (!own && !reading.has(key)) {
    reading.add(key)
    queueMicrotask(
      () =>
        void useWorkflowsStore
          .getState()
          .load(hostId)
          .finally(() => reading.delete(key)),
    )
  }
  return own ?? EMPTY
}
