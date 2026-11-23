// What the spreadsheet worker sends the Files pane for each sheet. Cells are packed into typed
// arrays and one string, so receiving a large sheet costs the page almost nothing.

import type { DocumentFailure } from './document-failure'

/** Excel's own limits; a sheet is never larger. */
export const MAX_ROWS = 1_048_576
export const MAX_COLS = 16_384

export type CellKind = 0 | 1 | 2
/** Text, a number or date, a boolean or error: what decides how a cell aligns. */
export const TEXT = 0
export const NUMBER = 1
export const SIGNAL = 2

export interface SheetData {
  name: string
  /** Rows and columns from A1 to the last cell the sheet uses. */
  rows: number
  cols: number
  /** The shown text of every non-empty cell, in row order and then column order, joined. */
  text: string
  /** Where cell `i`'s text ends in `text`; it starts where cell `i - 1`'s does. */
  cellEnd: Uint32Array
  cellCol: Uint16Array
  cellKind: Uint8Array
  /** The first cell of each row, `rows + 1` long, so row `r` holds cells `rowStart[r]` to `rowStart[r + 1]`. */
  rowStart: Uint32Array
  /** Merged ranges as first row, first column, last row, last column, flat. */
  merges: Uint32Array
  /** Pixels per column or row with 0 for a hidden one; null when the sheet sets none. */
  colWidths: Float32Array | null
  rowHeights: Float32Array | null
}

export type SheetRequest = { bytes: Uint8Array }

export type SheetMessage =
  | { kind: 'sheet'; sheet: SheetData }
  | { kind: 'done' }
  | { kind: 'failed'; reason: DocumentFailure }

/** The transferable buffers of a sheet. */
export function sheetBuffers(sheet: SheetData): ArrayBuffer[] {
  const buffers: ArrayBufferView[] = [
    sheet.cellEnd,
    sheet.cellCol,
    sheet.cellKind,
    sheet.rowStart,
    sheet.merges,
  ]
  if (sheet.colWidths) buffers.push(sheet.colWidths)
  if (sheet.rowHeights) buffers.push(sheet.rowHeights)
  return buffers.map((array) => array.buffer as ArrayBuffer)
}
