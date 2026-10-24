// A canvas's pages, found in its markup without running it, and their places on the canvas. See
// docs/design/artifacts.md#the-canvas-format.

import { THUMBNAIL_PAGES, type ThumbnailPage } from '@shared/artifacts'

/** What the format reads of an element; a DOM element is one. */
export interface MarkupElement {
  readonly children: ArrayLike<MarkupElement>
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
}

export interface CanvasPage {
  /** As written; null when empty, for the page to be named by its number. */
  name: string | null
  /** In reading order, from 1. */
  number: number
  /** As `?page=<group>.<index>` counts them: the body's group from 1, or 0 outside any. */
  group: number
  index: number
  width: number
  height: number
}

/** A row of the canvas: a group's pages under its title, or a run of pages outside any group. */
export interface CanvasRow {
  title: string | null
  pages: CanvasPage[]
}

export const DEFAULT_PAGE_SIZE = { width: 1280, height: 800 }
const MIN_SIZE = 64
const MAX_SIZE = 8_000
export const PAGE_GAP = 48
export const ROW_GAP = 220
export const ROW_PAGES = 6

const SIZE = /^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$/i

function pageSize(value: string | null): { width: number; height: number } {
  const match = value === null ? null : SIZE.exec(value)
  if (!match) return DEFAULT_PAGE_SIZE
  const clamp = (n: number): number => Math.min(MAX_SIZE, Math.max(MIN_SIZE, n))
  return { width: clamp(Number(match[1])), height: clamp(Number(match[2])) }
}

/** The rows of the pages a body marks, in reading order. */
export function canvasRows(body: MarkupElement): CanvasRow[] {
  const rows: CanvasRow[] = []
  let loose: CanvasRow | null = null
  let groups = 0
  let looseIndex = 0
  let number = 0
  const page = (el: MarkupElement, group: number, index: number): CanvasPage => ({
    name: el.getAttribute('data-page')?.trim() || null,
    number: ++number,
    group,
    index,
    ...pageSize(el.getAttribute('data-page-size')),
  })
  for (const child of Array.from(body.children)) {
    // Counted as the protocol's `:nth-child(n of [data-page-group])` counts them.
    const group = child.hasAttribute('data-page-group') ? ++groups : null
    if (child.hasAttribute('data-page')) {
      loose ??= rows[rows.push({ title: null, pages: [] }) - 1]!
      loose.pages.push(page(child, 0, ++looseIndex))
      continue
    }
    if (group === null) continue
    loose = null
    let index = 0
    const pages: CanvasPage[] = []
    for (const el of Array.from(child.children)) {
      if (el.hasAttribute('data-page')) pages.push(page(el, group, ++index))
    }
    if (pages.length) {
      rows.push({ title: child.getAttribute('data-page-group')?.trim() || null, pages })
    }
  }
  return rows
}

/** The pages of an artifact's HTML, parsed inert: no script runs and nothing loads. */
export function parseCanvas(html: string): CanvasRow[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return canvasRows(doc.body)
}

export interface PlacedPage extends CanvasPage {
  x: number
  y: number
}

/** A group's title over the first line of its row, which may wrap. */
export interface RowTitle {
  title: string
  x: number
  y: number
  width: number
}

export interface CanvasLayout {
  pages: PlacedPage[]
  titles: RowTitle[]
  width: number
  height: number
}

/** Each page's place in canvas pixels; a row wraps after six pages. */
export function layoutCanvas(rows: readonly CanvasRow[]): CanvasLayout {
  const pages: PlacedPage[] = []
  const titles: RowTitle[] = []
  let y = 0
  let width = 0
  for (const row of rows) {
    for (let start = 0; start < row.pages.length; start += ROW_PAGES) {
      let x = 0
      let height = 0
      for (const p of row.pages.slice(start, start + ROW_PAGES)) {
        pages.push({ ...p, x, y })
        x += p.width + PAGE_GAP
        height = Math.max(height, p.height)
      }
      if (start === 0 && row.title) titles.push({ title: row.title, x: 0, y, width: x - PAGE_GAP })
      width = Math.max(width, x - PAGE_GAP)
      y += height + ROW_GAP
    }
  }
  return { pages, titles, width, height: Math.max(0, y - ROW_GAP) }
}

/** A canvas's thumbnail layout, or null when its markup holds fewer than two pages. */
export function thumbnailLayout(rows: readonly CanvasRow[]): ThumbnailPage[] | null {
  const { pages } = layoutCanvas(rows)
  if (pages.length < 2) return null
  return pages.slice(0, THUMBNAIL_PAGES).map((p) => ({
    group: p.group,
    index: p.index,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
  }))
}
