import { create } from 'zustand'
import type { SessionFindMatch } from '@shared/agent-host'

/** What a session's find bar has found: its matches, oldest first, and the one it is at. */
export interface ShownFind {
  matches: readonly SessionFindMatch[]
  currentId: string | null
}

interface FindStore {
  /** By session, while its find bar is open and has matches; the outline marks them. */
  shown: Record<string, ShownFind>
  /** A match the outline asked the find bar to go to; `nonce` tells a repeated ask apart. */
  asked: Record<string, { entryId: string; nonce: number }>
}

export const useFindStore = create<FindStore>()(() => ({ shown: {}, asked: {} }))

export function showFind(sessionId: string, find: ShownFind | null): void {
  useFindStore.setState((s) => {
    if (find) return { shown: { ...s.shown, [sessionId]: find } }
    if (!(sessionId in s.shown)) return s
    const shown = { ...s.shown }
    delete shown[sessionId]
    return { shown }
  })
}

let nonce = 0

/** Asks the session's find bar to go to one of its matches. */
export function askFindMatch(sessionId: string, entryId: string): void {
  useFindStore.setState((s) => ({
    asked: { ...s.asked, [sessionId]: { entryId, nonce: ++nonce } },
  }))
}
