// The split view's layout: a tree of splits that lay their children side by side or one above
// the other, down to the panes, each node holding a share of its split, and the pane in focus.
// Every rule here is pure.

import { isAgentId, type AgentId } from '@shared/thread'

export type PaneView =
  | { kind: 'session'; sessionId: string; projectPath: string }
  // A New session screen: its agent, host, project and parent follow it out of focus. `hostId` is
  // the host chosen before a project: another host's id, null for this computer, and unset until
  // one is chosen, when the project decides.
  | {
      kind: 'new'
      agentId: AgentId | null
      projectPath: string | null
      noProject: boolean
      hostId?: string | null
      parentId?: string
    }

export interface Pane {
  kind: 'pane'
  id: string
  view: PaneView
  /** Of its split's length along the split's direction. */
  share: number
}

/** `row` lays its children side by side, `column` one above the other. */
export type Direction = 'row' | 'column'

export interface Split {
  kind: 'split'
  id: string
  direction: Direction
  /** Two or more, none of them a split of the same direction. */
  children: Node[]
  share: number
}

export type Node = Pane | Split

export interface Layout {
  root: Node
  /** The id of the pane in focus. */
  focus: string
}

export const MAX_PANES = 9
export const MIN_PANE_WIDTH = 360
export const MIN_PANE_HEIGHT = 240
/** The desk between two panes, which holds their resize handle. */
export const PANE_GAP = 8
/** The band along the split's edges where a drop takes the split's whole side. */
export const EDGE_BAND = 24

export type DropSide = 'left' | 'right' | 'top' | 'bottom' | 'center'
export type EdgeSide = Exclude<DropSide, 'center'>

/** Where a drop goes: a side of a pane, or with no pane a whole side of the split. */
export type Place = { paneId: string; side: DropSide } | { paneId: null; side: EdgeSide }

export type Box = { left: number; top: number; right: number; bottom: number }
export type Size = { width: number; height: number }

export type SplitReason = 'panes' | 'room'

export interface SideRoom {
  ok: boolean
  reason: SplitReason | null
}

const ROOM: SideRoom = { ok: true, reason: null }

export const newSessionView = (): PaneView => ({
  kind: 'new',
  agentId: null,
  projectPath: null,
  noProject: false,
})

let sequence = 0

function newId(kind: 'pane' | 'split'): string {
  sequence += 1
  return `${kind}-${Date.now().toString(36)}-${sequence.toString(36)}`
}

export function createPane(view: PaneView = newSessionView()): Pane {
  return { kind: 'pane', id: newId('pane'), view, share: 1 }
}

/** A layout of one pane: the main area as it is without a split. */
export function createLayout(view: PaneView = newSessionView()): Layout {
  const pane = createPane(view)
  return { root: pane, focus: pane.id }
}

function panesOf(node: Node): Pane[] {
  return node.kind === 'pane' ? [node] : node.children.flatMap(panesOf)
}

/** The panes in tree order: left to right in a row, top to bottom in a column, depth first. */
export function allPanes(layout: Layout): Pane[] {
  return panesOf(layout.root)
}

/** The panes' ids in the order Mod+1 to Mod+9 pick. */
export function paneOrder(layout: Layout): string[] {
  return allPanes(layout).map((pane) => pane.id)
}

export function isSplit(layout: Layout): boolean {
  return layout.root.kind === 'split'
}

export function findPane(layout: Layout, paneId: string): Pane | undefined {
  return allPanes(layout).find((pane) => pane.id === paneId)
}

export function focusedPane(layout: Layout): Pane {
  return findPane(layout, layout.focus) ?? allPanes(layout)[0]!
}

export function paneWithSession(layout: Layout, sessionId: string): Pane | undefined {
  return allPanes(layout).find(
    (pane) => pane.view.kind === 'session' && pane.view.sessionId === sessionId,
  )
}

export function newSessionPane(layout: Layout): Pane | undefined {
  return allPanes(layout).find((pane) => pane.view.kind === 'new')
}

function mapNode(node: Node, map: (pane: Pane) => Pane): Node {
  if (node.kind === 'pane') return map(node)
  return { ...node, children: node.children.map((child) => mapNode(child, map)) }
}

/** The layout with every pane passed through `map`, the tree kept as it is. */
export function mapPanes(layout: Layout, map: (pane: Pane) => Pane): Layout {
  return { ...layout, root: mapNode(layout.root, map) }
}

export function setPaneView(layout: Layout, paneId: string, view: PaneView): Layout {
  return mapPanes(layout, (pane) => (pane.id === paneId ? { ...pane, view } : pane))
}

export function focusPane(layout: Layout, paneId: string): Layout {
  return findPane(layout, paneId) ? { ...layout, focus: paneId } : layout
}

/**
 * Where a pane shows a view: a session already in a pane puts that pane in focus, as New session
 * does the pane that shows it; anything else goes to the pane in focus.
 */
export function showView(layout: Layout, view: PaneView): Layout {
  const existing =
    view.kind === 'session' ? paneWithSession(layout, view.sessionId) : newSessionPane(layout)
  if (existing) {
    const next = view.kind === 'new' ? setPaneView(layout, existing.id, view) : layout
    return focusPane(next, existing.id)
  }
  return setPaneView(layout, focusedPane(layout).id, view)
}

/**
 * After a session left the list: its pane closes, and in the only pane the view takes its place,
 * which New session and a page keep.
 */
export function closeSessionPane(layout: Layout, sessionId: string, fallback: PaneView): Layout {
  const pane = paneWithSession(layout, sessionId)
  if (!pane) return layout
  if (!isSplit(layout)) return setPaneView(layout, pane.id, fallback)
  return closePane(layout, pane.id)
}

/** Shares of one split that no longer add up to one are stretched in proportion. */
function normalizeShares<T extends { share: number }>(items: T[]): T[] {
  const total = items.reduce((sum, item) => sum + item.share, 0)
  if (total <= 0) return items.map((item) => ({ ...item, share: 1 / items.length }))
  return items.map((item) => ({ ...item, share: item.share / total }))
}

/**
 * The node in its canonical form: a split of one child gives way to it, a child split of the same
 * direction gives its children to its parent, and every split's shares add up to one.
 */
function normalizeNode(node: Node): Node {
  if (node.kind === 'pane') return node
  const children = normalizeShares(node.children).flatMap((child): Node[] => {
    const next = normalizeNode(child)
    if (next.kind === 'split' && next.direction === node.direction) {
      return next.children.map((grandchild) => ({
        ...grandchild,
        share: grandchild.share * next.share,
      }))
    }
    return [next]
  })
  if (children.length === 1) return { ...children[0]!, share: node.share }
  return { ...node, children: normalizeShares(children) }
}

/** The layout in its canonical form, the root holding the whole room. */
export function normalizeLayout(layout: Layout): Layout {
  return { ...layout, root: { ...normalizeNode(layout.root), share: 1 } }
}

/** The tree with only the panes `keep` holds, splits left empty dropped; null with none left. */
function filterNode(node: Node, keep: (pane: Pane) => boolean): Node | null {
  if (node.kind === 'pane') return keep(node) ? node : null
  const children = node.children.flatMap((child) => {
    const kept = filterNode(child, keep)
    return kept ? [kept] : []
  })
  return children.length === 0 ? null : { ...node, children }
}

/** The smallest room a node takes, with the desk between its parts. */
function minSize(node: Node): Size {
  if (node.kind === 'pane') return { width: MIN_PANE_WIDTH, height: MIN_PANE_HEIGHT }
  const sizes = node.children.map(minSize)
  const gaps = PANE_GAP * (sizes.length - 1)
  const widths = sizes.map((size) => size.width)
  const heights = sizes.map((size) => size.height)
  return node.direction === 'row'
    ? { width: sum(widths) + gaps, height: Math.max(...heights) }
    : { width: Math.max(...widths), height: sum(heights) + gaps }
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

// Half a pixel, so a box measured at fractional pixels still takes what it just fits.
const fits = (node: Node, size: Size) => {
  const min = minSize(node)
  return min.width <= size.width + 0.5 && min.height <= size.height + 0.5
}

function minLength(node: Node, direction: Direction): number {
  const min = minSize(node)
  return direction === 'row' ? min.width : min.height
}

const directionOf = (side: EdgeSide): Direction =>
  side === 'left' || side === 'right' ? 'row' : 'column'

const leads = (side: EdgeSide) => side === 'left' || side === 'top'

/** The pane split in two along the side's direction, the new pane on that side taking half. */
function besidePane(node: Node, paneId: string, side: EdgeSide, added: Pane): Node {
  const direction = directionOf(side)
  if (node.kind === 'pane') {
    if (node.id !== paneId) return node
    const halves: Node[] = [
      { ...added, share: 0.5 },
      { ...node, share: 0.5 },
    ]
    return {
      kind: 'split',
      id: newId('split'),
      direction,
      share: node.share,
      children: leads(side) ? halves : halves.reverse(),
    }
  }
  const at = node.children.findIndex((child) => child.kind === 'pane' && child.id === paneId)
  if (at >= 0 && node.direction === direction) {
    const target = node.children[at]!
    const half = target.share / 2
    const children = [...node.children]
    children[at] = { ...target, share: half }
    children.splice(leads(side) ? at : at + 1, 0, { ...added, share: half })
    return { ...node, children }
  }
  return {
    ...node,
    children: node.children.map((child) => besidePane(child, paneId, side, added)),
  }
}

/** The share of the split's length a pane dropped on one of its edges takes. */
export function edgeShare(layout: Layout, side: EdgeSide): number {
  const { root } = layout
  return root.kind === 'split' && root.direction === directionOf(side)
    ? 1 / (root.children.length + 1)
    : 1 / 2
}

/** A pane across the whole side of the split, sharing that side equally with what is there. */
function atEdge(root: Node, side: EdgeSide, added: Pane, share: number): Node {
  const direction = directionOf(side)
  const parts: Node[] =
    root.kind === 'split' && root.direction === direction
      ? root.children.map((child) => ({ ...child, share: child.share * (1 - share) }))
      : [{ ...root, share: 1 - share }]
  const pane = { ...added, share }
  return {
    kind: 'split',
    id: root.kind === 'split' && root.direction === direction ? root.id : newId('split'),
    direction,
    share: 1,
    children: leads(side) ? [pane, ...parts] : [...parts, pane],
  }
}

function placed(layout: Layout, place: Place, view: PaneView): Layout | null {
  if (place.side === 'center') return null
  const pane = createPane(view)
  const root =
    place.paneId === null
      ? atEdge(layout.root, place.side, pane, edgeShare(layout, place.side))
      : besidePane(layout.root, place.paneId, place.side, pane)
  return normalizeLayout({ root, focus: pane.id })
}

/** Whether the split can take a new pane at that place, and why not. */
export function canPlace(layout: Layout, place: Place, size: Size): SideRoom {
  if (place.side === 'center') return ROOM
  if (place.paneId !== null && !findPane(layout, place.paneId)) return { ok: false, reason: 'room' }
  if (allPanes(layout).length >= MAX_PANES) return { ok: false, reason: 'panes' }
  const next = placed(layout, place, newSessionView())
  return next && fits(next.root, size) ? ROOM : { ok: false, reason: 'room' }
}

/** Whether the split can take a new pane on that side of the pane, and why not. */
export function canSplit(layout: Layout, paneId: string, side: DropSide, size: Size): SideRoom {
  return canPlace(layout, { paneId, side }, size)
}

/**
 * Whether the pane runs along the split's whole side: across its whole height for the left and
 * right edges, its whole width for the top and bottom, as no split of the other direction holds it.
 */
function spansSide(layout: Layout, paneId: string, side: EdgeSide): boolean {
  const across = directionOf(side) === 'row' ? 'column' : 'row'
  const walk = (node: Node): boolean | null => {
    if (node.kind === 'pane') return node.id === paneId ? true : null
    for (const child of node.children) {
      const found = walk(child)
      if (found !== null) return found && node.direction !== across
    }
    return null
  }
  return walk(layout.root) ?? false
}

function edgeUnder(pointer: { x: number; y: number }, area: Box): EdgeSide | null {
  if (pointer.x < area.left + EDGE_BAND) return 'left'
  if (pointer.x >= area.right - EDGE_BAND) return 'right'
  if (pointer.y < area.top + EDGE_BAND) return 'top'
  if (pointer.y >= area.bottom - EDGE_BAND) return 'bottom'
  return null
}

/** The layout a drop counts against: the pane that already shows the dragged view taken out. */
export function dropBase(layout: Layout, from: string | null): Layout {
  return from && isSplit(layout) && findPane(layout, from) ? closePane(layout, from) : layout
}

/**
 * The place under the pointer: the split's edge band for a pane across its whole side, unless the
 * pane under it spans that side already; else a third across or a quarter down the middle third
 * of the pane for its side, else the pane. Null outside the panes and over the pane the dragged
 * view shows in, `from`, where the drop would change nothing.
 */
export function dropPlace(
  pointer: { x: number; y: number },
  boxes: readonly (Box & { paneId: string })[],
  layout: Layout,
  from: string | null,
  area: Box,
): Place | null {
  const box = boxes.find(
    (b) => pointer.x >= b.left && pointer.x < b.right && pointer.y >= b.top && pointer.y < b.bottom,
  )
  if (!box) return null
  const size = { width: area.right - area.left, height: area.bottom - area.top }
  const own = box.paneId === from
  const base = dropBase(layout, from)
  const edge = edgeUnder(pointer, area)
  if (edge) {
    // The pane's own edge already does what the band would; over the dragged pane it is no move.
    const spans = own ? spansSide(layout, box.paneId, edge) : spansSide(base, box.paneId, edge)
    if (!spans && canPlace(base, { paneId: null, side: edge }, size).ok) {
      return { paneId: null, side: edge }
    }
  }
  if (own || !findPane(base, box.paneId)) return null
  const third = (box.right - box.left) / 3
  const quarter = (box.bottom - box.top) / 4
  const at = (side: DropSide): Place | null =>
    canPlace(base, { paneId: box.paneId, side }, size).ok ? { paneId: box.paneId, side } : null
  return (
    (pointer.x < box.left + third ? at('left') : null) ??
    (pointer.x >= box.right - third ? at('right') : null) ??
    (pointer.y < box.top + quarter ? at('top') : null) ??
    (pointer.y >= box.bottom - quarter ? at('bottom') : null) ?? {
      paneId: box.paneId,
      side: 'center',
    }
  )
}

/**
 * A view dropped at a place: beside or above the pane, or across a side of the split, as a split,
 * else in the pane's place, where a view the pane showed leaves the split. A pane dropped over
 * itself changes nothing.
 */
export function dropView(layout: Layout, view: PaneView, place: Place, size: Size): Layout | null {
  const from = view.kind === 'session' ? paneWithSession(layout, view.sessionId) : undefined
  if (place.paneId === null) {
    if (from && !isSplit(layout)) return null
    const base = dropBase(layout, from?.id ?? null)
    return canPlace(base, place, size).ok ? placed(base, place, view) : null
  }
  const target = findPane(layout, place.paneId)
  if (!target) return null
  if (from?.id === target.id) return null
  if (place.side === 'center') {
    // Two panes trade places; a view from outside the split takes this pane's place.
    const swapped = from ? setPaneView(layout, from.id, target.view) : layout
    return { ...setPaneView(swapped, target.id, view), focus: target.id }
  }
  // A view the split holds leaves its pane first, so the room and the limit count without it.
  const base = dropBase(layout, from?.id ?? null)
  return splitAt(base, target.id, place.side, view, size)
}

/**
 * Puts a view beside or above the pane in a new pane, which takes half of the pane's room. Null
 * when the split has no room for that side.
 */
export function splitAt(
  layout: Layout,
  paneId: string,
  side: DropSide,
  view: PaneView,
  size: Size,
): Layout | null {
  const place: Place = { paneId, side }
  return canPlace(layout, place, size).ok ? placed(layout, place, view) : null
}

/** Adds a session the split does not hold beside or below the pane in focus, from the menu. */
export function openBeside(
  layout: Layout,
  view: PaneView,
  side: 'right' | 'bottom',
  size: Size,
): Layout | null {
  return splitAt(layout, focusedPane(layout).id, side, view, size)
}

/**
 * Removes a pane, sharing its room out in proportion among its split's others; a split left with
 * one part gives way to it. The focus goes to the pane before, else the one after.
 */
export function closePane(layout: Layout, paneId: string): Layout {
  if (!isSplit(layout)) return layout
  const order = paneOrder(layout)
  const at = order.indexOf(paneId)
  if (at < 0) return layout
  const root = filterNode(layout.root, (pane) => pane.id !== paneId)!
  const focus = layout.focus === paneId ? (order[at - 1] ?? order[at + 1]!) : layout.focus
  return normalizeLayout({ root, focus })
}

/** A node as the split shows it: a shown part of the tree, sized among its shown siblings. */
export type ShownNode =
  | {
      kind: 'pane'
      /** The id of the node in its split's children, which its panel is named and resized by. */
      slot: string
      /** Percent of its split's shown length. */
      size: number
      pane: Pane
    }
  | {
      kind: 'split'
      slot: string
      size: number
      id: string
      direction: Direction
      children: ShownNode[]
    }

export interface VisibleLayout {
  root: ShownNode
  /** The panes in view, in tree order. */
  panes: string[]
}

/**
 * The shown tree. A split with one shown part stays a split of that part, so the part keeps its
 * place among the page's elements and is not drawn again when the others fold or come back.
 */
function shownNode(node: Node, keep: ReadonlySet<string>): ShownNode | null {
  if (node.kind === 'pane') {
    return keep.has(node.id) ? { kind: 'pane', slot: node.id, size: node.share, pane: node } : null
  }
  const children = node.children.flatMap((child) => {
    const shown = shownNode(child, keep)
    return shown ? [shown] : []
  })
  if (children.length === 0) return null
  const total = sum(children.map((child) => child.size))
  return {
    kind: 'split',
    slot: node.id,
    size: node.share,
    id: node.id,
    direction: node.direction,
    children: children.map((child) => ({
      ...child,
      size: total > 0 ? (child.size / total) * 100 : 100 / children.length,
    })),
  }
}

/** The smallest length a shown node takes along a direction, for the panel that holds it. */
export function shownMinLength(node: ShownNode, direction: Direction): number {
  return minLength(asNode(node), direction)
}

function asNode(node: ShownNode): Node {
  if (node.kind === 'pane') return node.pane
  return {
    kind: 'split',
    id: node.id,
    direction: node.direction,
    share: node.size,
    children: node.children.map(asNode),
  }
}

/** Each pane's centre, from the shares, in a box of that size. */
function centres(node: Node, box: Box, out: Map<string, { x: number; y: number }>): void {
  if (node.kind === 'pane') {
    out.set(node.id, { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 })
    return
  }
  const row = node.direction === 'row'
  let at = row ? box.left : box.top
  const length = row ? box.right - box.left : box.bottom - box.top
  for (const child of node.children) {
    const end = at + child.share * length
    centres(child, row ? { ...box, left: at, right: end } : { ...box, top: at, bottom: end }, out)
    at = end
  }
}

/**
 * What the split shows in its present box. All of it when it fits; else, among the sets of panes
 * that hold the pane in focus and fit, the one with the most panes, then the most of those shown
 * before, then the nearest to the pane in focus. Nine panes make at most 256 such sets.
 */
export function visibleLayout(
  layout: Layout,
  size: Size,
  before: readonly string[] = [],
): VisibleLayout {
  const order = paneOrder(layout)
  const all = shownNode(layout.root, new Set(order))!
  if (order.length === 1 || fits(layout.root, size)) {
    return { root: { ...all, size: 100 }, panes: order }
  }
  const focus = focusedPane(layout).id
  const others = order.filter((id) => id !== focus)
  const shownBefore = new Set(before)
  const at = new Map<string, { x: number; y: number }>()
  centres(layout.root, { left: 0, top: 0, right: size.width, bottom: size.height }, at)
  const centre = at.get(focus)!
  const distance = (id: string) => {
    const point = at.get(id)!
    return Math.hypot(point.x - centre.x, point.y - centre.y)
  }
  let best: { keep: Set<string>; count: number; kept: number; distance: number } | null = null
  for (let mask = 0; mask < 1 << others.length; mask++) {
    const picked = others.filter((_, index) => mask & (1 << index))
    const count = picked.length + 1
    if (best && count < best.count) continue
    const kept =
      picked.filter((id) => shownBefore.has(id)).length + (shownBefore.has(focus) ? 1 : 0)
    const far = sum(picked.map(distance))
    if (
      best &&
      count === best.count &&
      (kept < best.kept || (kept === best.kept && far >= best.distance))
    ) {
      continue
    }
    const keep = new Set([focus, ...picked])
    const tree = filterNode(layout.root, (pane) => keep.has(pane.id))!
    if (!fits(tree, size)) continue
    best = { keep, count, kept, distance: far }
  }
  const keep = best?.keep ?? new Set([focus])
  const root = shownNode(layout.root, keep)!
  return { root: { ...root, size: 100 }, panes: order.filter((id) => keep.has(id)) }
}

/** The pane at the shown split's top left, which leaves room for the traffic lights. */
export function cornerPane(node: ShownNode): string {
  return node.kind === 'pane' ? node.pane.id : cornerPane(node.children[0]!)
}

/**
 * A split's shares after a resize, from the percentages of its shown parts: what the resize left
 * them, scaled back to the shown parts' own shares so a folded part keeps its place.
 */
export function resizeSplit(
  layout: Layout,
  splitId: string,
  sizes: Record<string, number>,
): Layout {
  const resize = (node: Node): Node => {
    if (node.kind === 'pane') return node
    if (node.id !== splitId) return { ...node, children: node.children.map(resize) }
    const shown = node.children.filter((child) => sizes[child.id] !== undefined)
    const total = sum(shown.map((child) => child.share))
    const given = sum(shown.map((child) => sizes[child.id] ?? 0))
    if (given <= 0) return node
    return {
      ...node,
      children: node.children.map((child) =>
        sizes[child.id] === undefined
          ? child
          : { ...child, share: (total * sizes[child.id]!) / given },
      ),
    }
  }
  return { ...layout, root: resize(layout.root) }
}

/**
 * The layout with the panes `keep` leaves out, closed as a close does: shares kept in proportion,
 * the saved pane in focus or else the first. Null when no pane is left.
 */
export function pruneLayout(layout: Layout, keep: (pane: Pane) => boolean): Layout | null {
  const root = filterNode(layout.root, keep)
  if (!root) return null
  const next = normalizeLayout({ root, focus: layout.focus })
  return findPane(next, next.focus) ? next : { ...next, focus: allPanes(next)[0]!.id }
}

export type SavedNode =
  | { kind: 'pane'; id: string; share: number; view: PaneView }
  | { kind: 'split'; id: string; share: number; direction: Direction; children: SavedNode[] }

export interface SavedLayout {
  root: SavedNode
  focus: string
}

/** The layout for storage: a New session pane is kept as New session with its defaults. */
export function saveLayout(layout: Layout): SavedLayout {
  const save = (node: Node): SavedNode =>
    node.kind === 'pane'
      ? {
          kind: 'pane',
          id: node.id,
          share: node.share,
          view: node.view.kind === 'new' ? newSessionView() : node.view,
        }
      : {
          kind: 'split',
          id: node.id,
          share: node.share,
          direction: node.direction,
          children: node.children.map(save),
        }
  return { root: save(layout.root), focus: layout.focus }
}

/**
 * A stored layout, as far as it is one; null for anything that is not. A layout saved as columns
 * of panes, before splits nested, reads as a row of columns.
 */
export function readLayout(saved: unknown): Layout | null {
  if (!saved || typeof saved !== 'object') return null
  const value = saved as Record<string, unknown>
  const root = 'root' in value ? readNode(value.root, 0) : readColumns(value.columns)
  if (!root) return null
  const panes = panesOf(root)
  if (panes.length > MAX_PANES) return null
  const ids = idsOf(root)
  if (new Set(ids).size !== ids.length) return null
  const layout = normalizeLayout({
    root,
    focus: typeof value.focus === 'string' ? value.focus : panes[0]!.id,
  })
  return findPane(layout, layout.focus) ? layout : focusPane(layout, allPanes(layout)[0]!.id)
}

function idsOf(node: Node): string[] {
  return node.kind === 'pane' ? [node.id] : [node.id, ...node.children.flatMap(idsOf)]
}

function readNode(saved: unknown, depth: number): Node | null {
  if (!saved || typeof saved !== 'object' || depth > MAX_PANES) return null
  const value = saved as Record<string, unknown>
  const { id, share } = value
  if (typeof id !== 'string' || typeof share !== 'number' || !(share > 0)) return null
  if (value.kind === 'pane') {
    const view = readView(value.view)
    return view ? { kind: 'pane', id, share, view } : null
  }
  if (value.kind !== 'split') return null
  if (value.direction !== 'row' && value.direction !== 'column') return null
  if (!Array.isArray(value.children) || value.children.length === 0) return null
  const children: Node[] = []
  for (const child of value.children) {
    const node = readNode(child, depth + 1)
    if (!node) return null
    children.push(node)
  }
  return { kind: 'split', id, share, direction: value.direction, children }
}

/** A split saved as columns left to right of panes top to bottom. */
function readColumns(saved: unknown): Node | null {
  if (!Array.isArray(saved) || saved.length === 0) return null
  const columns: Node[] = []
  for (const column of saved) {
    if (!column || typeof column !== 'object') return null
    const { id, share, panes } = column as Record<string, unknown>
    if (typeof id !== 'string' || typeof share !== 'number' || !(share > 0)) return null
    if (!Array.isArray(panes) || panes.length === 0) return null
    const children: Node[] = []
    for (const pane of panes) {
      const node = readNode({ ...(pane as object), kind: 'pane' }, 1)
      if (!node) return null
      children.push(node)
    }
    columns.push({ kind: 'split', id, share, direction: 'column', children })
  }
  return { kind: 'split', id: newId('split'), share: 1, direction: 'row', children: columns }
}

function readView(view: unknown): PaneView | null {
  if (!view || typeof view !== 'object') return null
  const value = view as Record<string, unknown>
  if (value.kind === 'session') {
    if (typeof value.sessionId !== 'string' || typeof value.projectPath !== 'string') return null
    return { kind: 'session', sessionId: value.sessionId, projectPath: value.projectPath }
  }
  if (value.kind === 'new') {
    return {
      kind: 'new',
      agentId: isAgentId(value.agentId) ? value.agentId : null,
      projectPath: typeof value.projectPath === 'string' ? value.projectPath : null,
      noProject: value.noProject === true,
      ...(typeof value.hostId === 'string' || value.hostId === null
        ? { hostId: value.hostId }
        : {}),
      ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
    }
  }
  return null
}
