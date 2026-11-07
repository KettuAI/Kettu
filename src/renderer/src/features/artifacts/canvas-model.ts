// A canvas document as the editor lays one of its canvases out: the pages, the sections around them
// and the notes, with the bounds the camera fits.

import {
  sectionBox,
  type Box,
  type CanvasDoc,
  type CanvasNote,
  type CanvasPage,
  type CanvasSection,
} from '@shared/canvas-doc'
import { THUMBNAIL_PAGES, type ThumbnailPage } from '@shared/artifacts'
import { noteBox } from './use-canvas-doc'

export interface PlacedSection extends CanvasSection {
  box: Box
}

export interface DocLayout {
  canvas: string
  pages: CanvasPage[]
  sections: PlacedSection[]
  notes: CanvasNote[]
  /** Around everything on the canvas; zero sized when it is empty. */
  bounds: Box
}

export function boundsOf(boxes: readonly Box[]): Box {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const b of boxes) {
    left = Math.min(left, b.x)
    top = Math.min(top, b.y)
    right = Math.max(right, b.x + b.width)
    bottom = Math.max(bottom, b.y + b.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function docLayout(doc: CanvasDoc, canvas: string): DocLayout {
  const pages = doc.pages.filter((p) => p.canvas === canvas)
  const sections: PlacedSection[] = []
  for (const s of doc.sections) {
    if (s.canvas !== canvas) continue
    const box = sectionBox({ pages }, s.id)
    if (box) sections.push({ ...s, box })
  }
  const notes = doc.notes.filter((n) => n.canvas === canvas)
  const bounds = boundsOf([
    ...pages,
    ...sections.map((s) => s.box),
    ...notes.map((n) => noteBox(n)),
  ])
  return { canvas, pages, sections, notes, bounds }
}

/** A canvas document's thumbnail layout: its first canvas's pages, moved to start at the origin. */
export function docThumbnailLayout(doc: CanvasDoc): ThumbnailPage[] | null {
  const first = doc.canvases[0]
  if (!first) return null
  const { pages } = docLayout(doc, first.id)
  if (pages.length === 0) return null
  const left = Math.min(...pages.map((p) => p.x))
  const top = Math.min(...pages.map((p) => p.y))
  return pages.slice(0, THUMBNAIL_PAGES).map((p, i) => ({
    group: 0,
    index: i + 1,
    file: p.file,
    x: Math.round(p.x - left),
    y: Math.round(p.y - top),
    width: p.width,
    height: p.height,
  }))
}

/** Edges and centres another box may snap to along one axis. */
function stops(box: Box, axis: 'x' | 'y'): number[] {
  const start = axis === 'x' ? box.x : box.y
  const size = axis === 'x' ? box.width : box.height
  return [start, start + size / 2, start + size]
}

export interface Snap {
  dx: number
  dy: number
  /** Guides to draw, in canvas pixels: vertical ones at x, horizontal ones at y. */
  guides: Array<{ axis: 'x' | 'y'; at: number; from: number; to: number }>
}

/**
 * How far to nudge `moving` so one of its edges or its centre lines up with another box's, within
 * `reach` canvas pixels on each axis, and the guides that show it.
 */
export function snap(moving: Box, others: readonly Box[], reach: number): Snap {
  const out: Snap = { dx: 0, dy: 0, guides: [] }
  for (const axis of ['x', 'y'] as const) {
    let best: { delta: number; at: number } | null = null
    for (const mine of stops(moving, axis)) {
      for (const other of others) {
        for (const theirs of stops(other, axis)) {
          const delta = theirs - mine
          if (Math.abs(delta) <= reach && (!best || Math.abs(delta) < Math.abs(best.delta))) {
            best = { delta, at: theirs }
          }
        }
      }
    }
    if (!best) continue
    if (axis === 'x') out.dx = best.delta
    else out.dy = best.delta
    const moved = { ...moving, x: moving.x + out.dx, y: moving.y + out.dy }
    const along = others.filter((o) => stops(o, axis).some((s) => Math.abs(s - best!.at) < 0.5))
    const span = [moved, ...along]
    const from = Math.min(...span.map((b) => (axis === 'x' ? b.y : b.x)))
    const to = Math.max(...span.map((b) => (axis === 'x' ? b.y + b.height : b.x + b.width)))
    out.guides.push({ axis, at: best.at, from, to })
  }
  return out
}

/** Whether two boxes overlap. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

export function contains(box: Box, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height
}

/** Where a line or arrow joined to pages runs: from the edge of one to the edge of the other. */
export function joinedEnds(
  note: Extract<CanvasNote, { kind: 'line' | 'arrow' | 'rect' | 'ellipse' }>,
  pages: readonly CanvasPage[],
): { x1: number; y1: number; x2: number; y2: number } {
  const from = note.from ? pages.find((p) => p.id === note.from) : undefined
  const to = note.to ? pages.find((p) => p.id === note.to) : undefined
  let { x1, y1, x2, y2 } = note
  const centre = (p: CanvasPage) => ({ x: p.x + p.width / 2, y: p.y + p.height / 2 })
  const edge = (p: CanvasPage, toward: { x: number; y: number }) => {
    const c = centre(p)
    const dx = toward.x - c.x
    const dy = toward.y - c.y
    const scale = Math.min(
      dx === 0 ? Infinity : p.width / 2 / Math.abs(dx),
      dy === 0 ? Infinity : p.height / 2 / Math.abs(dy),
    )
    return Number.isFinite(scale) ? { x: c.x + dx * scale, y: c.y + dy * scale } : c
  }
  if (from) ({ x: x1, y: y1 } = edge(from, to ? centre(to) : { x: x2, y: y2 }))
  if (to) ({ x: x2, y: y2 } = edge(to, from ? centre(from) : { x: x1, y: y1 }))
  return { x1, y1, x2, y2 }
}
