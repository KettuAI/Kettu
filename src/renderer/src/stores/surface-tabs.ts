import {
  isDocKind,
  selectDoc,
  toggleSidePane,
  useViewStore,
  type DocKind,
  type SidePane,
  type SingleTab,
} from './view'

/** The kinds a session has several tabs of: terminals, browser pages and devices. */
export type SurfaceKind = 'terminal' | 'browser' | 'devices'

/** A tab's kind: one of the three, a file, diff or artifact, or a kind a session has one of. */
export type TabKind = SurfaceKind | DocKind | SingleTab

export function isSurfaceKind(pane: SidePane | null | undefined): pane is SurfaceKind {
  return pane === 'terminal' || pane === 'browser' || pane === 'devices'
}

/** A tab's place in the row: its kind and its id within that kind, empty for a kind of one. */
export function surfaceKey(kind: TabKind, id = ''): string {
  return `${kind}:${id}`
}

export function kindOfKey(key: string): TabKind {
  return key.slice(0, key.indexOf(':')) as TabKind
}

// Per panel, keys of tabs that are away for now and keep their place: pages a restart reopens.
const awaited = new Map<string, Set<string>>()

/** Keeps the place of tabs that will come back under other keys, until `replaceSurfaceKey`. */
export function awaitSurfaceKeys(panel: string, keys: readonly string[]): void {
  if (keys.length > 0) awaited.set(panel, new Set(keys))
  else awaited.delete(panel)
}

/** A tab came back under a new key: it takes the place its old key held. */
export function replaceSurfaceKey(panel: string, from: string, to: string): void {
  awaited.get(panel)?.delete(from)
  if (from === to) return
  useViewStore.setState((s) => {
    const order = s.sideOrder[panel]
    if (!order?.includes(from)) return s
    const next = order.filter((key) => key !== to).map((key) => (key === from ? to : key))
    return { sideOrder: { ...s.sideOrder, [panel]: next } }
  })
}

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
  useViewStore.setState((s) => {
    const before = s.sideOrder[panel] ?? []
    const away = awaited.get(panel)
    // A tab that is away keeps its place among the ones shown.
    const present = new Set(keys)
    const next = away?.size
      ? [
          ...before.filter((key) => present.has(key) || away.has(key)),
          ...keys.filter((key) => !before.includes(key)),
        ]
      : [...keys]
    if (before.length === next.length && before.every((key, index) => key === next[index])) {
      return s
    }
    const sideOrder = { ...s.sideOrder }
    delete sideOrder[panel]
    if (next.length > 0) sideOrder[panel] = next
    return { sideOrder }
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
 * A kind's last tab went while the panel shows it: the panel shows the nearest tab of another
 * kind, after where that kind's tabs were or else before, and the side panel's list once the row
 * is empty. A panel showing something else is left as it is.
 */
export function foldSurface(panel: string, kind: SurfaceKind): void {
  const view = useViewStore.getState()
  if (view.sidePane[panel] !== kind) return
  const order = view.sideOrder[panel] ?? []
  const last = order.findLastIndex((key) => kindOfKey(key) === kind)
  const others = order
    .map((key, index) => ({ key, kind: kindOfKey(key), index }))
    .filter((other) => other.kind !== kind)
  const next = others.find((other) => other.index > last) ?? others.at(-1)
  if (next && isDocKind(next.kind)) selectDoc(panel, next.key)
  else toggleSidePane(panel, next?.kind ?? 'surfaces', true)
}
