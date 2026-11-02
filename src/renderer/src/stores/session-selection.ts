import { create } from 'zustand'

// The sidebar rows picked with Mod-click or Shift-click, which a row's menu then acts on together.
// A plain click, opening a session or leaving the list clears it.

interface SelectionStore {
  ids: string[]
  /** Where a Shift-click range starts: the row picked last, or the session in front. */
  anchor: string | null
}

export const useSessionSelection = create<SelectionStore>()(() => ({ ids: [], anchor: null }))

/**
 * Mod-click: adds the row, or takes it out. The first pick also takes in the session in front, as
 * a file manager's selection starts from the item already selected.
 */
export function toggleSelected(id: string, current: string | null): void {
  useSessionSelection.setState((s) => {
    const base = s.ids.length === 0 && current && current !== id ? [current] : s.ids
    const ids = base.includes(id) ? base.filter((other) => other !== id) : [...base, id]
    return { ids, anchor: id }
  })
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
