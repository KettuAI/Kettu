// Where a sheet's rows, columns and cells lie, so the grid draws only what is in view.

import type { SheetData } from './sheet-data'

/** One axis of the grid: the sizes of its rows or columns, and where each starts. */
export interface Axis {
  count: number
  /** The size of a row or column the sheet sets none for. */
  fallback: number
  /** Where each starts, `count + 1` long, when sizes vary; null when all are the fallback. */
  offsets: Float64Array | null
  total: number
}

export function makeAxis(count: number, sizes: Float32Array | null, fallback: number): Axis {
  if (!sizes) return { count, fallback, offsets: null, total: count * fallback }
  const offsets = new Float64Array(count + 1)
  for (let i = 0; i < count; i++) {
    offsets[i + 1] = offsets[i]! + (i < sizes.length ? sizes[i]! : fallback)
  }
  return { count, fallback, offsets, total: offsets[count]! }
}

export function startOf(axis: Axis, index: number): number {
  return axis.offsets ? axis.offsets[index]! : index * axis.fallback
}

export function sizeOf(axis: Axis, index: number): number {
  return startOf(axis, index + 1) - startOf(axis, index)
}

/** The row or column that holds `position`, from the start of the axis. */
export function indexAt(axis: Axis, position: number): number {
  const last = axis.count - 1
  if (!axis.offsets) return Math.min(last, Math.max(0, Math.floor(position / axis.fallback)))
  let low = 0
  let high = last
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (axis.offsets[middle]! <= position) low = middle
    else high = middle - 1
  }
  return low
}

/** A column's letters: A to Z, then AA and on. */
export function columnName(index: number): string {
  let name = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}

/** The first cell of row `r` in column `c` or after it, as its index among the sheet's cells. */
export function firstCellFrom(sheet: SheetData, r: number, c: number): number {
  if (r >= sheet.rows) return 0
  let low = sheet.rowStart[r]!
  let high = sheet.rowStart[r + 1]!
  while (low < high) {
    const middle = (low + high) >> 1
    if (sheet.cellCol[middle]! < c) low = middle + 1
    else high = middle
  }
  return low
}

/** The text of the cell at row `r` and column `c`, or null when it has none. */
export function textAt(sheet: SheetData, r: number, c: number): string | null {
  const index = firstCellFrom(sheet, r, c)
  if (r >= sheet.rows || index >= sheet.rowStart[r + 1]! || sheet.cellCol[index] !== c) return null
  return cellText(sheet, index)
}

export function cellText(sheet: SheetData, index: number): string {
  return sheet.text.slice(index === 0 ? 0 : sheet.cellEnd[index - 1]!, sheet.cellEnd[index]!)
}

/** A merged range: first row, first column, last row, last column. */
export type Merge = readonly [number, number, number, number]

/** The merges that reach into the rows `r0` to `r1` and the columns `c0` to `c1`. */
export function mergesIn(
  sheet: SheetData,
  r0: number,
  r1: number,
  c0: number,
  c1: number,
): Merge[] {
  const found: Merge[] = []
  const { merges } = sheet
  for (let i = 0; i < merges.length; i += 4) {
    const merge = [merges[i]!, merges[i + 1]!, merges[i + 2]!, merges[i + 3]!] as const
    if (merge[0] <= r1 && merge[2] >= r0 && merge[1] <= c1 && merge[3] >= c0) found.push(merge)
  }
  return found
}
