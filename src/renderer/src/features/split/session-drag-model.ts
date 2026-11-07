import { useMemo } from 'react'
import { useDraggable } from '@dnd-kit/react'
import { create } from 'zustand'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useOverlayStore } from '@renderer/stores/overlays'
import { useViewStore } from '@renderer/stores/view'
import {
  allPanes,
  dropBase,
  dropPlace,
  edgeShare,
  findPane,
  paneWithSession,
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

/** The pane the dragged session shows in: the pane whose title it is, or its row's session's. */
function fromPane(layout: Layout, data: SessionDragData): string | null {
  if (data.paneId) return findPane(layout, data.paneId) ? data.paneId : null
  return paneWithSession(layout, data.sessionId)?.id ?? null
}

/**
 * The room the hint covers: half the pane on that side, or the pane; at the split's edge, the
 * strip of its whole side that the new pane takes.
 */
function hintBox(base: Layout, place: Place, area: Box): Box | null {
  if (place.paneId === null) {
    const share = edgeShare(base, place.side)
    const width = (area.right - area.left) * share
    const height = (area.bottom - area.top) * share
    if (place.side === 'left') return { ...area, right: area.left + width }
    if (place.side === 'right') return { ...area, left: area.right - width }
    if (place.side === 'top') return { ...area, bottom: area.top + height }
    return { ...area, top: area.bottom - height }
  }
  const own = paneElements.get(place.paneId)
  if (!own) return null
  const box = rectOf(own)
  const middleX = (box.left + box.right) / 2
  const middleY = (box.top + box.bottom) / 2
  if (place.side === 'left') return { ...box, right: middleX }
  if (place.side === 'right') return { ...box, left: middleX }
  if (place.side === 'top') return { ...box, bottom: middleY }
  if (place.side === 'bottom') return { ...box, top: middleY }
  return box
}

/** The place under the pointer, and the room the hint covers; null outside or over its own pane. */
export function placeUnderPointer(
  data: SessionDragData,
  point: { x: number; y: number },
): { place: Place; box: Box } | null {
  const { layout, visiblePanes } = useViewStore.getState()
  if (!splitElement) return null
  const from = fromPane(layout, data)
  const shown = visiblePanes.length ? visiblePanes : allPanes(layout).map((pane) => pane.id)
  const measured = shown.flatMap((paneId) => {
    const element = paneElements.get(paneId)
    return element && findPane(layout, paneId) ? [{ paneId, ...rectOf(element) }] : []
  })
  const area = rectOf(splitElement)
  const place = dropPlace(point, measured, layout, from, area)
  if (!place) return null
  const box = hintBox(dropBase(layout, from), place, area)
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
