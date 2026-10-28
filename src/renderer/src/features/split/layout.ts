// The split view's layout: columns left to right of panes top to bottom, each pane and column
// holding a share of the room above it, and the pane in focus. Every rule here is pure.

import { AGENT_IDS, type AgentId } from '@shared/thread'

export type PaneView =
  | { kind: 'session'; sessionId: string; projectPath: string }
  // A New session screen: its agent, project and parent follow it out of focus.
  | {
      kind: 'new'
      agentId: AgentId | null
      projectPath: string | null
      noProject: boolean
      parentId?: string
    }

export interface Pane {
  id: string
  view: PaneView
  /** Of its column's height. */
  share: number
}

export interface Column {
  id: string
  panes: Pane[]
  /** Of the split's width. */
  share: number
}

export interface Layout {
  columns: Column[]
  /** The id of the pane in focus. */
  focus: string
}

export const MAX_COLUMNS = 3
export const MAX_PANES = 3
export const MIN_COLUMN_WIDTH = 360
export const MIN_PANE_HEIGHT = 240
/** The desk between two panes, which holds their resize handle. */
export const PANE_GAP = 8
export const MAX_SHOWN_PANES = MAX_COLUMNS * MAX_PANES

export type DropSide = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface Place {
  paneId: string
  side: DropSide
}

/** The pointer's place against one pane, and the box it was measured in. */
export type Box = { left: number; top: number; right: number; bottom: number }

export type SplitReason = 'columns' | 'panes' | 'room'

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

function newId(kind: 'pane' | 'column'): string {
  sequence += 1
  return `${kind}-${Date.now().toString(36)}-${sequence.toString(36)}`
}

export function createPane(view: PaneView = newSessionView()): Pane {
  return { id: newId('pane'), view, share: 1 }
}

/** A layout of one pane: the main area as it is without a split. */
export function createLayout(view: PaneView = newSessionView()): Layout {
  const pane = createPane(view)
  return { columns: [{ id: newId('column'), panes: [pane], share: 1 }], focus: pane.id }
}

export function allPanes(layout: Layout): Pane[] {
  return layout.columns.flatMap((column) => column.panes)
}

/** The panes column by column and top to bottom: the order Mod+1 to Mod+9 pick. */
export function paneOrder(layout: Layout): string[] {
  return allPanes(layout).map((pane) => pane.id)
}

export function isSplit(layout: Layout): boolean {
  return allPanes(layout).length > 1
}

export function findPane(layout: Layout, paneId: string): Pane | undefined {
  return allPanes(layout).find((pane) => pane.id === paneId)
}

export function columnOf(layout: Layout, paneId: string): Column | undefined {
  return layout.columns.find((column) => column.panes.some((pane) => pane.id === paneId))
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

export function setPaneView(layout: Layout, paneId: string, view: PaneView): Layout {
  return {
    ...layout,
    columns: layout.columns.map((column) => ({
      ...column,
      panes: column.panes.map((pane) => (pane.id === paneId ? { ...pane, view } : pane)),
    })),
  }
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

/** The place under the pointer: a third across, a quarter down the middle third, else the pane. */
export function dropPlace(
  pointer: { x: number; y: number },
  boxes: readonly (Box & { paneId: string })[],
  layout: Layout,
  size: { width: number; height: number },
): Place | null {
  const box = boxes.find(
    (b) => pointer.x >= b.left && pointer.x < b.right && pointer.y >= b.top && pointer.y < b.bottom,
  )
  if (!box) return null
  const third = (box.right - box.left) / 3
  const quarter = (box.bottom - box.top) / 4
  const centre = (side: DropSide): Place => ({ paneId: box.paneId, side })
  if (pointer.x < box.left + third && canSplit(layout, box.paneId, 'left', size).ok) {
    return centre('left')
  }
  if (pointer.x >= box.right - third && canSplit(layout, box.paneId, 'right', size).ok) {
    return centre('right')
  }
  if (pointer.y < box.top + quarter && canSplit(layout, box.paneId, 'top', size).ok) {
    return centre('top')
  }
  if (pointer.y >= box.bottom - quarter && canSplit(layout, box.paneId, 'bottom', size).ok) {
    return centre('bottom')
  }
  return centre('center')
}

export function columnsFit(width: number, count: number): boolean {
  return count * MIN_COLUMN_WIDTH + (count - 1) * PANE_GAP <= width
}

export function panesFit(height: number, count: number): boolean {
  return count * MIN_PANE_HEIGHT + (count - 1) * PANE_GAP <= height
}

/** Whether the split can take a new column or pane on that side of the pane, and why not. */
export function canSplit(
  layout: Layout,
  paneId: string,
  side: DropSide,
  size: { width: number; height: number },
): SideRoom {
  const column = columnOf(layout, paneId)
  if (!column) return { ok: false, reason: 'room' }
  if (side === 'left' || side === 'right') {
    if (layout.columns.length >= MAX_COLUMNS) return { ok: false, reason: 'columns' }
    if (!columnsFit(size.width, layout.columns.length + 1)) return { ok: false, reason: 'room' }
    return ROOM
  }
  if (side === 'top' || side === 'bottom') {
    if (column.panes.length >= MAX_PANES) return { ok: false, reason: 'panes' }
    if (!panesFit(size.height, column.panes.length + 1)) return { ok: false, reason: 'room' }
    return ROOM
  }
  return ROOM
}

/**
 * A view dropped at a place: beside or above the pane as a split, else in its place, where a view
 * the pane showed leaves the split. A pane dropped over itself changes nothing.
 */
export function dropView(
  layout: Layout,
  view: PaneView,
  place: Place,
  size: { width: number; height: number },
): Layout | null {
  const target = findPane(layout, place.paneId)
  if (!target) return null
  const from = view.kind === 'session' ? paneWithSession(layout, view.sessionId) : undefined
  if (from?.id === target.id) return null
  if (place.side === 'center') {
    // Two panes trade places; a view from outside the split takes this pane's place.
    const swapped = from ? setPaneView(layout, from.id, target.view) : layout
    return { ...setPaneView(swapped, target.id, view), focus: target.id }
  }
  // A view the split holds leaves its pane first, so the room and the limits count without it.
  const base = from ? removePane(layout, from.id) : layout
  return splitAt(base, target.id, place.side, view, size)
}

/**
 * Puts a view in a new column beside the pane, or a new pane above or below it, which takes half
 * the room of the one it splits. Null when the split has no room for that side.
 */
export function splitAt(
  layout: Layout,
  paneId: string,
  side: DropSide,
  view: PaneView,
  size: { width: number; height: number },
): Layout | null {
  if (!canSplit(layout, paneId, side, size).ok) return null
  const column = columnOf(layout, paneId)!
  const pane = createPane(view)
  if (side === 'left' || side === 'right') {
    const at = layout.columns.indexOf(column)
    const half = column.share / 2
    const columns = [...layout.columns]
    columns[at] = { ...column, share: half }
    columns.splice(side === 'left' ? at : at + 1, 0, {
      id: newId('column'),
      panes: [{ ...pane, share: 1 }],
      share: half,
    })
    return { columns, focus: pane.id }
  }
  const at = column.panes.findIndex((p) => p.id === paneId)
  const panes = [...column.panes]
  const half = panes[at]!.share / 2
  panes[at] = { ...panes[at]!, share: half }
  panes.splice(side === 'top' ? at : at + 1, 0, { ...pane, share: half })
  const columns = layout.columns.map((c) => (c.id === column.id ? { ...c, panes } : c))
  return { columns, focus: pane.id }
}

/** Adds a session the split does not hold beside or below the pane in focus, from the menu. */
export function openBeside(
  layout: Layout,
  view: PaneView,
  side: 'right' | 'bottom',
  size: { width: number; height: number },
): Layout | null {
  return splitAt(layout, focusedPane(layout).id, side, view, size)
}

/** Removes a pane, then the column it leaves empty, sharing their room out in proportion. */
export function closePane(layout: Layout, paneId: string): Layout {
  if (!isSplit(layout)) return layout
  return removePane(layout, paneId)
}

function removePane(layout: Layout, paneId: string): Layout {
  const order = paneOrder(layout)
  const at = order.indexOf(paneId)
  const before = order[at - 1] ?? order[at + 1]
  const columns = layout.columns
    .map((column) => {
      if (!column.panes.some((pane) => pane.id === paneId)) return column
      const panes = column.panes.filter((pane) => pane.id !== paneId)
      return panes.length === 0 ? null : { ...column, panes: normalizeShares(panes) }
    })
    .filter((column): column is Column => column !== null)
  const next = { columns: normalizeShares(columns), focus: layout.focus }
  if (layout.focus === paneId && before) next.focus = before
  if (!findPane(next, next.focus)) next.focus = allPanes(next)[0]!.id
  return next
}

/** Shares of one axis that no longer add up to one are stretched in proportion. */
function normalizeShares<T extends { share: number }>(items: T[]): T[] {
  const total = items.reduce((sum, item) => sum + item.share, 0)
  if (total <= 0) return items.map((item) => ({ ...item, share: 1 / items.length }))
  return items.map((item) => ({ ...item, share: item.share / total }))
}

/** Every share of the layout added up again after it changed: one axis per call. */
export function normalizeLayout(layout: Layout): Layout {
  const columns = normalizeShares(
    layout.columns.map((column) => ({ ...column, panes: normalizeShares(column.panes) })),
  )
  return { columns, focus: layout.focus }
}

export function focusedColumn(layout: Layout): Column {
  return columnOf(layout, focusedPane(layout).id) ?? layout.columns[0]!
}

export interface VisibleLayout {
  columns: { id: string; panes: string[] }[]
  /** The panes in view, in the order they show. */
  panes: string[]
}

/** What the split showed before, so it stays as the room moves. */
export interface FoldedBefore {
  columns: string[]
  panes: Record<string, string[]>
}

export const NOTHING_SHOWN: FoldedBefore = { columns: [], panes: {} }

/**
 * What the split shows in its present box: as many columns as fit, as a run that holds the column
 * in focus and stays the run shown before while that still holds it, else shifts as little as it
 * can; and in each column, the panes that fit the same way.
 */
export function visibleLayout(
  layout: Layout,
  size: { width: number; height: number },
  before: FoldedBefore = NOTHING_SHOWN,
): VisibleLayout {
  const fitColumns = Math.max(
    1,
    Math.min(
      layout.columns.length,
      Math.floor((size.width + PANE_GAP) / (MIN_COLUMN_WIDTH + PANE_GAP)),
    ),
  )
  const focusColumn = layout.columns.indexOf(focusedColumn(layout))
  const prevStart = before.columns[0]
    ? layout.columns.findIndex((column) => column.id === before.columns[0])
    : -1
  const run = choose(runsOf(layout.columns.length, fitColumns), focusColumn, prevStart)
  const columns = layout.columns.slice(run.start, run.start + run.length).map((column) => {
    const focus = layout.columns[focusColumn]?.id === column.id
    const fitPanes = Math.max(
      1,
      Math.min(
        column.panes.length,
        Math.floor((size.height + PANE_GAP) / (MIN_PANE_HEIGHT + PANE_GAP)),
      ),
    )
    const prevPane = before.panes[column.id]?.[0]
    const prevPaneStart = prevPane ? column.panes.findIndex((p) => p.id === prevPane) : -1
    const focusIndex = column.panes.findIndex((pane) => pane.id === layout.focus)
    const panes = choose(
      runsOf(column.panes.length, fitPanes),
      focus ? focusIndex : -1,
      prevPaneStart,
    )
    return {
      id: column.id,
      panes: column.panes.slice(panes.start, panes.start + panes.length).map((pane) => pane.id),
    }
  })
  return { columns, panes: columns.flatMap((column) => column.panes) }
}

type Run = { start: number; length: number }

function runsOf(count: number, length: number): Run[] {
  const size = Math.min(count, Math.max(1, length))
  return Array.from({ length: count - size + 1 }, (_, start) => ({ start, length: size }))
}

const within = (run: Run, at: number) => at >= run.start && at < run.start + run.length

/** The run shown before while it still holds `at`, else the one holding it, else the first. */
function choose(runs: Run[], at: number, previousStart: number): Run {
  if (at < 0) return runs.find((run) => run.start === previousStart) ?? runs[0]!
  return (
    runs.find((run) => run.start === previousStart && within(run, at)) ??
    runs
      .filter((run) => within(run, at))
      .sort((a, b) => Math.abs(a.start - previousStart) - Math.abs(b.start - previousStart))[0] ??
    runs[0]!
  )
}

/** The visible panes' and columns' shares of their group, as a resizable panel takes them. */
export function visibleSizes(
  layout: Layout,
  visible: VisibleLayout,
): { columns: Record<string, number>; panes: Record<string, number> } {
  const columns: Record<string, number> = {}
  const panes: Record<string, number> = {}
  for (const shown of visible.columns) {
    const column = layout.columns.find((c) => c.id === shown.id)!
    columns[shown.id] = column.share
    const part: Record<string, number> = {}
    for (const paneId of shown.panes)
      part[paneId] = column.panes.find((p) => p.id === paneId)!.share
    scale(part)
    Object.assign(panes, part)
  }
  scale(columns)
  return { columns, panes }
}

function scale(shares: Record<string, number>): void {
  const total = Object.values(shares).reduce((sum, share) => sum + share, 0)
  if (total <= 0) return
  for (const key of Object.keys(shares)) shares[key] = (shares[key]! / total) * 100
}

export interface SavedPane {
  id: string
  share: number
  view: PaneView
}

export interface SavedLayout {
  columns: { id: string; share: number; panes: SavedPane[] }[]
  focus: string
}

/** The layout for storage: a New session pane is kept as New session with its defaults. */
export function saveLayout(layout: Layout): SavedLayout {
  return {
    columns: layout.columns.map((column) => ({
      id: column.id,
      share: column.share,
      panes: column.panes.map((pane) => ({
        id: pane.id,
        share: pane.share,
        view: pane.view.kind === 'new' ? newSessionView() : pane.view,
      })),
    })),
    focus: layout.focus,
  }
}

/** A stored layout, as far as it is one; null for anything that is not. */
export function readLayout(saved: unknown): Layout | null {
  if (!saved || typeof saved !== 'object') return null
  const value = saved as Partial<SavedLayout>
  if (!Array.isArray(value.columns) || value.columns.length === 0) return null
  const columns: Column[] = []
  for (const column of value.columns) {
    if (!column || typeof column !== 'object') return null
    const { id, share, panes } = column
    if (typeof id !== 'string' || typeof share !== 'number' || !Array.isArray(panes)) return null
    if (panes.length === 0) return null
    const kept: Pane[] = []
    for (const pane of panes) {
      const view = readView(pane?.view)
      if (!pane || typeof pane.id !== 'string' || typeof pane.share !== 'number' || !view) {
        return null
      }
      kept.push({ id: pane.id, share: pane.share, view })
    }
    columns.push({ id, share, panes: kept })
  }
  const layout = normalizeLayout({
    columns,
    focus: typeof value.focus === 'string' ? value.focus : columns[0]!.panes[0]!.id,
  })
  return findPane(layout, layout.focus) ? layout : focusPane(layout, columns[0]!.panes[0]!.id)
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
      agentId: (AGENT_IDS as readonly string[]).includes(value.agentId as string)
        ? (value.agentId as AgentId)
        : null,
      projectPath: typeof value.projectPath === 'string' ? value.projectPath : null,
      noProject: value.noProject === true,
      ...(typeof value.parentId === 'string' ? { parentId: value.parentId } : {}),
    }
  }
  return null
}

/**
 * Columns' shares after a resize, as percentages of the shown ones: what the resize left them,
 * scaled back to the whole split so a folded column keeps its place.
 */
export function resizeColumns(layout: Layout, sizes: Record<string, number>): Layout {
  const shown = layout.columns.filter((column) => sizes[column.id] !== undefined)
  const total = shown.reduce((sum, column) => sum + column.share, 0)
  const sum = shown.reduce((acc, column) => acc + (sizes[column.id] ?? 0), 0)
  if (sum <= 0) return layout
  return {
    ...layout,
    columns: layout.columns.map((column) =>
      sizes[column.id] === undefined
        ? column
        : { ...column, share: (total * sizes[column.id]!) / sum },
    ),
  }
}

/** A column's panes' shares after a resize, as percentages of the shown ones. */
export function resizePanes(
  layout: Layout,
  columnId: string,
  sizes: Record<string, number>,
): Layout {
  return {
    ...layout,
    columns: layout.columns.map((column) => {
      if (column.id !== columnId) return column
      const shown = column.panes.filter((pane) => sizes[pane.id] !== undefined)
      const sum = shown.reduce((acc, pane) => acc + (sizes[pane.id] ?? 0), 0)
      if (sum <= 0) return column
      const total = shown.reduce((acc, pane) => acc + pane.share, 0)
      return {
        ...column,
        panes: column.panes.map((pane) =>
          sizes[pane.id] === undefined ? pane : { ...pane, share: (total * sizes[pane.id]!) / sum },
        ),
      }
    }),
  }
}

/**
 * The layout with the panes `keep` leaves out, their columns closing as a close does: shares kept
 * in proportion, the saved pane in focus or else the first. Null when no pane is left.
 */
export function pruneLayout(layout: Layout, keep: (pane: Pane) => boolean): Layout | null {
  const columns = layout.columns
    .map((column) => {
      const panes = column.panes.filter(keep)
      return panes.length === 0 ? null : { ...column, panes: normalizeShares(panes) }
    })
    .filter((column): column is Column => column !== null)
  if (columns.length === 0) return null
  const order = allPanes({ columns, focus: layout.focus })
  const focus = order.some((pane) => pane.id === layout.focus) ? layout.focus : order[0]!.id
  return normalizeLayout({ columns, focus })
}
