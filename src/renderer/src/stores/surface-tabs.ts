import { create } from 'zustand'
import { toggleSidePane, useViewStore, type SidePane } from './view'

/** The side panes whose items share one row of tabs: terminals, browser pages and devices. */
export type SurfaceKind = 'terminal' | 'browser' | 'devices'

/** Whether the pane is one of the row's kinds, or the row's own pane while it has no tab yet. */
export function isSurfacePane(pane: SidePane | null | undefined): pane is SurfaceKind | 'surfaces' {
  return pane === 'terminal' || pane === 'browser' || pane === 'devices' || pane === 'surfaces'
}

/** A tab's place in the row: its kind and its id within that kind. */
export function surfaceKey(kind: SurfaceKind, id: string): string {
  return `${kind}:${id}`
}

export function kindOfKey(key: string): SurfaceKind {
  return key.slice(0, key.indexOf(':')) as SurfaceKind
}

interface SurfaceTabsStore {
  /**
   * Per panel, the row as last shown: tabs in the order they opened, then as the user dragged
   * them. Kept for the app's run, as the terminals' own order is.
   */
  order: Record<string, string[]>
}

export const useSurfaceTabsStore = create<SurfaceTabsStore>()(() => ({ order: {} }))

/** The keys in the row's order: those the row knows where it had them, new ones after them. */
export function arrangeSurfaceKeys(
  order: readonly string[] | undefined,
  keys: readonly string[],
): string[] {
  const present = new Set(keys)
  const kept = (order ?? []).filter((key) => present.has(key))
  const known = new Set(kept)
  return [...kept, ...keys.filter((key) => !known.has(key))]
}

/** Keeps the row as shown, so a tab that opens later lands after every tab already there. */
export function recordSurfaceOrder(panel: string, keys: readonly string[]): void {
  useSurfaceTabsStore.setState((s) => {
    const before = s.order[panel]
    if (before?.length === keys.length && before.every((key, index) => key === keys[index])) {
      return s
    }
    return { order: { ...s.order, [panel]: [...keys] } }
  })
}

/** Moves a tab to another place in the row. */
export function moveSurfaceTab(
  panel: string,
  keys: readonly string[],
  key: string,
  to: number,
): void {
  const next = keys.filter((other) => other !== key)
  if (next.length === keys.length) return
  next.splice(Math.min(Math.max(to, 0), next.length), 0, key)
  recordSurfaceOrder(panel, next)
}

/**
 * A kind's last tab went while its pane shows: the pane gives way to the nearest tab of another
 * kind, after where that kind's tabs were or else before, and the panel folds only once the row
 * is empty. A panel showing something else is left as it is.
 */
export function foldSurface(panel: string, kind: SurfaceKind): void {
  if (useViewStore.getState().sidePane[panel] !== kind) return
  const order = useSurfaceTabsStore.getState().order[panel] ?? []
  const last = order.findLastIndex((key) => kindOfKey(key) === kind)
  const others = order
    .map((key, index) => ({ kind: kindOfKey(key), index }))
    .filter((other) => other.kind !== kind)
  const next = others.find((other) => other.index > last) ?? others.at(-1)
  if (next) toggleSidePane(panel, next.kind, true)
  else toggleSidePane(panel, kind, false)
}
