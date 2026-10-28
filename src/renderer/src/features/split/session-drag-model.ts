import { useMemo } from 'react'
import { useDraggable } from '@dnd-kit/react'
import { create } from 'zustand'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useOverlayStore } from '@renderer/stores/overlays'
import { useViewStore } from '@renderer/stores/view'
import {
  allPanes,
  closePane,
  columnOf,
  dropPlace,
  findPane,
  type Box,
  type Layout,
  type PaneView,
  type Place,
} from './layout'

// Dragging a session into the split: rows of the sidebar and session panes' titles carry a
// session, the panes report the room they take, and the drop goes where the pointer is.

export interface SessionDragData {
  sessionId: string
  /** The pane the drag starts in, for a pane's title; none for a sidebar row. */
  paneId?: string
}

// While a drag runs it counts as an overlay, so the browser pane shows the still of its page.
export const DRAG_LAYER = 'split-drag'

const paneElements = new Map<string, HTMLElement>()
let splitElement: HTMLElement | null = null

export function registerPaneBox(paneId: string, element: HTMLElement | null): void {
  if (element) paneElements.set(paneId, element)
  else paneElements.delete(paneId)
}

export function registerSplitBox(element: HTMLElement | null): void {
  splitElement = element
}

/** The split's box as it is now, for what a side of it can take. */
export function splitSize(): { width: number; height: number } | null {
  if (!splitElement) return null
  const { width, height } = splitElement.getBoundingClientRect()
  return { width, height }
}

interface SessionDragStore {
  dragging: SessionDragData | null
  /** Where the drop would go, and the room the hint covers, in the window's coordinates. */
  drop: { place: Place; box: Box } | null
}

export const useSessionDragStore = create<SessionDragStore>()(() => ({
  dragging: null,
  drop: null,
}))

const rectOf = (element: Element): Box => {
  const { left, top, right, bottom } = element.getBoundingClientRect()
  return { left, top, right, bottom }
}

/** The layout the drop counts against: the dragged pane out of it, as its move leaves it. */
function baseLayout(layout: Layout, data: SessionDragData): Layout {
  const from = data.paneId
    ? findPane(layout, data.paneId)
    : allPanes(layout).find(
        (pane) => pane.view.kind === 'session' && pane.view.sessionId === data.sessionId,
      )
  return from && allPanes(layout).length > 1 ? closePane(layout, from.id) : layout
}

/** The room the hint covers: half the column beside the pane, half the pane, or the pane. */
function hintBox(layout: Layout, place: Place): Box | null {
  const pane = findPane(layout, place.paneId)
  const column = columnOf(layout, place.paneId)
  const own = paneElements.get(place.paneId)
  if (!pane || !column || !own) return null
  const box = rectOf(own)
  if (place.side === 'center') return box
  if (place.side === 'top' || place.side === 'bottom') {
    const middle = (box.top + box.bottom) / 2
    return place.side === 'top' ? { ...box, bottom: middle } : { ...box, top: middle }
  }
  // A new column takes half of the pane's column, at the column's full height.
  const siblings = column.panes.flatMap((sibling) => {
    const element = paneElements.get(sibling.id)
    return element ? [rectOf(element)] : []
  })
  const top = Math.min(...siblings.map((rect) => rect.top))
  const bottom = Math.max(...siblings.map((rect) => rect.bottom))
  const middle = (box.left + box.right) / 2
  return place.side === 'left'
    ? { ...box, top, bottom, right: middle }
    : { ...box, top, bottom, left: middle }
}

/** The place under the pointer, and the room the hint covers; null outside or over its own pane. */
export function placeUnderPointer(
  data: SessionDragData,
  point: { x: number; y: number },
): { place: Place; box: Box } | null {
  const { layout, visiblePanes } = useViewStore.getState()
  if (!splitElement) return null
  const base = baseLayout(layout, data)
  const shown = visiblePanes.length ? visiblePanes : allPanes(layout).map((pane) => pane.id)
  const measured = shown.flatMap((paneId) => {
    const element = paneElements.get(paneId)
    return element && findPane(base, paneId) ? [{ paneId, ...rectOf(element) }] : []
  })
  const size = splitElement.getBoundingClientRect()
  const place = dropPlace(point, measured, base, size)
  if (!place) return null
  // Over its own pane nothing shows, whether the drag started from it or from its row.
  const from = data.paneId
    ? data.paneId
    : allPanes(layout).find(
        (pane) => pane.view.kind === 'session' && pane.view.sessionId === data.sessionId,
      )?.id
  if (place.paneId === from) return null
  const box = hintBox(layout, place)
  return box ? { place, box } : null
}

/** The view a dragged session opens, for its drop. */
export function viewOf(data: SessionDragData): PaneView | null {
  const summary = useSessionsStore.getState().byId[data.sessionId]
  return summary
    ? { kind: 'session', sessionId: summary.id, projectPath: summary.projectPath }
    : null
}

/** A sidebar row as a drag source, which a press still clicks. */
export function useSessionDragSource(sessionId: string, disabled = false) {
  const data = useMemo<SessionDragData>(() => ({ sessionId }), [sessionId])
  return useDraggable({ id: `session:${sessionId}`, data, disabled })
}

/** A session pane's title as a drag source, for moving the pane. */
export function usePaneDragSource(paneId: string, sessionId: string, disabled = false) {
  const data = useMemo<SessionDragData>(() => ({ sessionId, paneId }), [paneId, sessionId])
  return useDraggable({ id: `pane:${paneId}`, data, disabled })
}

/** Opens the drag: the chip shows, the browser pane takes its still, and the hint finds its pane. */
export function dragStarted(data: SessionDragData, point: { x: number; y: number }): void {
  useSessionDragStore.setState({ dragging: data, drop: placeUnderPointer(data, point) })
  useOverlayStore.getState().set(DRAG_LAYER, true)
}

export function dragMoved(point: { x: number; y: number }): void {
  const { dragging } = useSessionDragStore.getState()
  if (!dragging) return
  useSessionDragStore.setState({ drop: placeUnderPointer(dragging, point) })
}

/** Ends the drag with the drop it made, or with nothing when it was canceled or left the panes. */
export function dragEnded(canceled: boolean): { data: SessionDragData; place: Place } | null {
  const { dragging, drop } = useSessionDragStore.getState()
  useSessionDragStore.setState({ dragging: null, drop: null })
  useOverlayStore.getState().set(DRAG_LAYER, false)
  return !canceled && dragging && drop ? { data: dragging, place: drop.place } : null
}
