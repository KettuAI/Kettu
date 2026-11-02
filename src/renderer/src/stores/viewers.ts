import { create } from 'zustand'
import type { SessionViewer } from '@shared/agent-host'

// Who else has each watched session in front, as its host last said: the session's top bar shows
// them. A host sends the list again whenever a window or device starts watching.

interface ViewersStore {
  bySession: Record<string, SessionViewer[]>
}

export const useViewersStore = create<ViewersStore>()(() => ({ bySession: {} }))

export function receiveViewers(sessionId: string, viewers: SessionViewer[]): void {
  if (viewers.length === 0) {
    forgetViewers(sessionId)
    return
  }
  useViewersStore.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: viewers } }))
}

export function forgetViewers(sessionId: string): void {
  useViewersStore.setState((s) => {
    if (!(sessionId in s.bySession)) return s
    const bySession = { ...s.bySession }
    delete bySession[sessionId]
    return { bySession }
  })
}

/** Their names, the host's windows under the host's own. */
export function viewerNames(viewers: readonly SessionViewer[], hostName: string): string[] {
  return viewers.map((viewer) => (viewer.kind === 'host' ? hostName : viewer.name))
}
