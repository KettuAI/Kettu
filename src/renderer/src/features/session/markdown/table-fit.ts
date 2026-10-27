import { useLayoutEffect, type RefObject } from 'react'
import { HAN } from '@renderer/lib/han'

/** How wide a column's floor may be, so paths, URLs and identifiers break instead of the table. */
const CAP_EM = 8

/** How a table fits the room it has. */
export type TableFitName = 'whole' | 'floors' | 'stack'

export interface TableFit {
  fit: TableFitName
  /** Each column's floor in pixels, for 'floors' only. */
  floors: number[]
}

/**
 * How a table fits `room`: as it is, at each column's floor (`cap` at most), or with its rows
 * stacked when even the floors do not fit side by side.
 */
export function fitTable(room: number, columns: number[], cap: number): TableFit {
  const whole = columns.reduce((sum, width) => sum + width, 0)
  if (whole <= room) return { fit: 'whole', floors: [] }
  const floors = columns.map((width) => Math.min(width, cap))
  const floored = floors.reduce((sum, width) => sum + width, 0)
  return floored <= room ? { fit: 'floors', floors } : { fit: 'stack', floors: [] }
}

interface Size {
  width: number
  height: number
}

interface Tracked {
  el: HTMLTableElement
  /** The size the last fit gave the table, whose notice observing it again reports. */
  kept: Size | null
  frame: number
}

const tracked = new Map<Element, Tracked>()
let sharedObserver: ResizeObserver | null = null

function sizeOf(el: Element): Size {
  const { width, height } = el.getBoundingClientRect()
  return { width, height }
}

function sameSize(a: Size, b: Size): boolean {
  return Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
}

function headerCells(el: HTMLTableElement): HTMLTableCellElement[] {
  const row = el.tHead?.rows[0]
  return row ? Array.from(row.cells) : []
}

/** One observer for every table. */
function observer(): ResizeObserver {
  sharedObserver ??= new ResizeObserver(read)
  return sharedObserver
}

/**
 * Runs after layout and before paint: the changed tables are reset, measured at their min-content
 * width in one layout, then fitted, so the first paint of an update is already fitted.
 */
function read(entries: ResizeObserverEntry[]): void {
  const changed = new Set<Tracked>()
  for (const entry of entries) {
    const table = tracked.get(entry.target)
    if (!table) continue
    const kept = table.kept
    table.kept = null
    // A fit changes the table's own size, so the notice its next observation gives is that fit,
    // not a change to fit.
    if (kept && sameSize(sizeOf(table.el), kept)) continue
    changed.add(table)
  }
  if (changed.size === 0) return
  // A fit changes the size of a table Chromium is watching, which it reports as a ResizeObserver
  // loop: every changed table is watched again only on the next frame.
  for (const table of changed) {
    observer().unobserve(table.el)
    reset(table.el)
  }
  // One layout at the min-content width, where each column is its widest whole word.
  for (const table of changed) table.el.style.width = 'min-content'
  const fits = [...changed].map((table) => [table, measure(table.el)] as const)
  for (const [table, fit] of fits) {
    table.el.style.width = ''
    if (fit && fit.fit !== 'whole') apply(table.el, fit)
  }
  // Read once more, so the notice each fit's change gives is known before it comes.
  for (const table of changed) table.kept = sizeOf(table.el)
  for (const table of changed) hold(table)
}

function reset(el: HTMLTableElement): void {
  el.removeAttribute('data-fit')
  el.style.width = ''
  for (const cell of el.querySelectorAll<HTMLTableCellElement>('th, td')) {
    cell.style.minWidth = ''
    cell.removeAttribute('data-label')
  }
}

/** The fit for a table laid out at its min-content width. */
function measure(el: HTMLTableElement): TableFit | null {
  const cells = headerCells(el)
  const box = el.parentElement
  if (cells.length === 0 || !box) return null
  const columns = cells.map((cell) => Math.round(cell.getBoundingClientRect().width))
  const fontSize = Number.parseFloat(getComputedStyle(el).fontSize)
  const cap = fontSize > 0 ? fontSize * CAP_EM : Number.POSITIVE_INFINITY
  return fitTable(box.clientWidth, columns, cap)
}

function apply(el: HTMLTableElement, fit: TableFit): void {
  el.dataset.fit = fit.fit
  const cells = headerCells(el)
  if (fit.fit === 'floors') {
    cells.forEach((cell, i) => {
      cell.style.minWidth = `${fit.floors[i]}px`
    })
    return
  }
  const labels = cells.map((cell) => {
    const name = (cell.textContent ?? '').trim()
    return name + (HAN.test(name) ? '：' : ': ')
  })
  for (const body of el.tBodies) {
    for (const row of body.rows) {
      Array.from(row.cells).forEach((cell, i) => {
        if (i === 0) return
        cell.setAttribute('data-label', labels[i] ?? '')
      })
    }
  }
}

/** Watch a table again on the next frame, once the frame that fitted it is painted. */
function hold(table: Tracked): void {
  cancelAnimationFrame(table.frame)
  table.frame = requestAnimationFrame(() => {
    table.frame = 0
    if (tracked.has(table.el)) observer().observe(table.el)
  })
}

/** Fits one table to its room as the room and the content change; `ref` is its `<table>`. */
export function useTableFit(ref: RefObject<HTMLTableElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const table: Tracked = { el, kept: null, frame: 0 }
    tracked.set(el, table)
    observer().observe(el)
    return () => {
      observer().unobserve(el)
      tracked.delete(el)
      cancelAnimationFrame(table.frame)
    }
  }, [ref])
}
