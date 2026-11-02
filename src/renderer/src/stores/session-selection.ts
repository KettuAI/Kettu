import { create } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import { useSessionsStore } from './sessions'
import { useViewStore } from './view'

// The sidebar rows picked with Mod-click or Shift-click, which a row's menu then acts on together.
// A plain click on a row, Esc there or another session coming to the front clears it, and a
// session that leaves the list, removed or archived, drops out of it.

interface SelectionStore {
  ids: string[]
  /** Where a Shift-click range starts: the row picked last, or the session in front. */
  anchor: string | null
}

export const useSessionSelection = create<SelectionStore>()(() => ({ ids: [], anchor: null }))

/** Mod-click: adds the row, or takes it out. */
export function toggleSelected(id: string): void {
  useSessionSelection.setState((s) => ({
    ids: s.ids.includes(id) ? s.ids.filter((other) => other !== id) : [...s.ids, id],
    anchor: id,
  }))
}

/** Shift-click: every row from the anchor to this one, in the order the sidebar lists them. */
export function selectRange(id: string, current: string | null, order: readonly string[]): void {
  useSessionSelection.setState((s) => {
    const anchor = s.anchor ?? current
    const from = anchor ? order.indexOf(anchor) : -1
    const to = order.indexOf(id)
    if (from === -1 || to === -1) return { ids: [id], anchor: id }
    const [start, end] = from < to ? [from, to] : [to, from]
    return { ids: order.slice(start, end + 1), anchor: s.anchor ?? anchor }
  })
}

export function clearSelection(): void {
  const { ids, anchor } = useSessionSelection.getState()
  if (ids.length > 0 || anchor !== null) useSessionSelection.setState({ ids: [], anchor: null })
}

/** The selection a row's menu acts on: several rows, one of them this one; otherwise null. */
export function selectionFor(id: string, ids: readonly string[]): readonly string[] | null {
  return ids.length > 1 && ids.includes(id) ? ids : null
}

function prune(byId: Record<string, SessionSummary>): void {
  const { ids, anchor } = useSessionSelection.getState()
  if (ids.length === 0 && anchor === null) return
  // The host archives only the top-level session; its sub-sessions leave the list with it.
  const listed = (id: string) => {
    let s = byId[id]
    while (s && !s.archivedAt && s.parentId) s = byId[s.parentId]
    return !!s && !s.archivedAt
  }
  const kept = ids.filter(listed)
  const from = anchor !== null && listed(anchor) ? anchor : null
  if (kept.length < ids.length || from !== anchor) {
    useSessionSelection.setState({ ids: kept, anchor: from })
  }
}

useSessionsStore.subscribe((state, previous) => {
  if (state.byId !== previous.byId) prune(state.byId)
})

// The last session in front, so coming back to it from a page keeps the picked rows.
let lastFront: string | null = null

useViewStore.subscribe((state) => {
  const front = state.main.kind === 'session' ? state.main.sessionId : null
  if (front === null || front === lastFront) return
  if (lastFront !== null) clearSelection()
  lastFront = front
})
