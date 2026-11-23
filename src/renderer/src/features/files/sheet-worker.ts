// Parses a workbook off the page's thread with SheetJS and sends back each visible sheet's shown
// text, merges, column widths and row heights. Formulas keep the values they were saved with, and
// no macro is read, so nothing runs.

import * as XLSX from 'xlsx'
import { holdsEncryptedPackage, isOle2 } from './office-bytes'
import {
  MAX_COLS,
  MAX_ROWS,
  NUMBER,
  SIGNAL,
  TEXT,
  sheetBuffers,
  type SheetData,
  type SheetMessage,
  type SheetRequest,
} from './sheet-data'

/** The size of a column and a row the sheet sets nothing for, as Excel draws them. */
const DEFAULT_COL = 64
const DEFAULT_ROW = 20

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SheetRequest>) => void) | null
  postMessage(message: SheetMessage, transfer?: Transferable[]): void
}

const ZIP_START = [0x50, 0x4b]

function kindOf(cell: XLSX.CellObject): number {
  if (cell.t === 'n' || cell.t === 'd') return NUMBER
  return cell.t === 'b' || cell.t === 'e' ? SIGNAL : TEXT
}

function textOf(cell: XLSX.CellObject): string {
  if (cell.w !== undefined) return cell.w
  return cell.v === undefined || cell.v === null ? '' : String(cell.v)
}

/** Sizes in pixels by index, or null when the sheet sets none. */
function sizes<T>(
  entries: (T | null | undefined)[] | undefined,
  count: number,
  fallback: number,
  pixels: (entry: T) => number | undefined,
  hidden: (entry: T) => boolean | undefined,
): Float32Array | null {
  if (!entries?.some(Boolean)) return null
  const out = new Float32Array(count).fill(fallback)
  for (let i = 0; i < Math.min(count, entries.length); i++) {
    const entry = entries[i]
    if (!entry) continue
    if (hidden(entry)) out[i] = 0
    else out[i] = pixels(entry) ?? fallback
  }
  return out
}

function pack(name: string, sheet: XLSX.WorkSheet): SheetData {
  const data = sheet['!data'] ?? []
  const end = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).e : { r: -1, c: -1 }
  const rows = Math.min(MAX_ROWS, Math.max(end.r + 1, data.length))
  let widest = end.c + 1
  for (const row of data) widest = Math.max(widest, row?.length ?? 0)
  const cols = Math.min(MAX_COLS, widest)

  const columns: number[] = []
  const texts: string[] = []
  const ends: number[] = []
  const kinds: number[] = []
  const rowStart = new Uint32Array(rows + 1)
  let length = 0
  for (let r = 0; r < rows; r++) {
    rowStart[r] = columns.length
    const row = data[r]
    if (!row) continue
    for (let c = 0; c < Math.min(row.length, cols); c++) {
      const cell = row[c]
      if (!cell) continue
      const text = textOf(cell)
      if (text === '') continue
      length += text.length
      texts.push(text)
      ends.push(length)
      columns.push(c)
      kinds.push(kindOf(cell))
    }
  }
  rowStart[rows] = columns.length

  const merges = (sheet['!merges'] ?? []).flatMap(({ s, e }) =>
    s.r < rows && s.c < cols ? [s.r, s.c, Math.min(e.r, rows - 1), Math.min(e.c, cols - 1)] : [],
  )
  return {
    name,
    rows,
    cols,
    text: texts.join(''),
    cellEnd: Uint32Array.from(ends),
    cellCol: Uint16Array.from(columns),
    cellKind: Uint8Array.from(kinds),
    rowStart,
    merges: Uint32Array.from(merges),
    colWidths: sizes(
      sheet['!cols'],
      cols,
      DEFAULT_COL,
      (col) => col.wpx,
      (col) => col.hidden,
    ),
    rowHeights: sizes(
      sheet['!rows'],
      rows,
      DEFAULT_ROW,
      (row) => row.hpx,
      (row) => row.hidden,
    ),
  }
}

function parse(bytes: Uint8Array): void {
  const archive = ZIP_START.every((byte, i) => bytes[i] === byte)
  if (isOle2(bytes) && holdsEncryptedPackage(bytes)) {
    return void scope.postMessage({ kind: 'failed', reason: 'encrypted' })
  }
  const options: XLSX.ParsingOptions = {
    type: 'array',
    dense: true,
    cellStyles: true,
    cellFormula: false,
    cellHTML: false,
  }
  // A workbook archive says which sheets are hidden without parsing them; any other is read whole.
  const visible = archive
    ? (() => {
        const index = XLSX.read(bytes, { type: 'array', sheets: [] })
        return index.SheetNames.flatMap((_, i) => (index.Workbook?.Sheets?.[i]?.Hidden ? [] : [i]))
      })()
    : undefined
  const book = XLSX.read(bytes, visible ? { ...options, sheets: visible } : options)
  book.SheetNames.forEach((name, i) => {
    const sheet = book.Sheets[name]
    // A chart sheet has no cells.
    if (!sheet || book.Workbook?.Sheets?.[i]?.Hidden || sheet['!type'] === 'chart') return
    const packed = pack(name, sheet)
    scope.postMessage({ kind: 'sheet', sheet: packed }, sheetBuffers(packed))
  })
  scope.postMessage({ kind: 'done' })
}

scope.onmessage = ({ data }) => {
  try {
    parse(data.bytes)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    scope.postMessage({
      kind: 'failed',
      reason: /password|encrypt/i.test(message) ? 'encrypted' : 'invalid',
    })
  }
}
