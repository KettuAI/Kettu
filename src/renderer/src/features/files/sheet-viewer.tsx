import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { File01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { OFFICE_PREVIEW_LIMIT } from '@shared/media'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { readMedia } from '@renderer/lib/media-bytes'
import { PaneEmpty, PaneIcon } from '@renderer/features/shell/panel-button'
import type { DocumentFailure } from './document-failure'
import { Lines } from './file-preview'
import type { SheetData, SheetMessage, SheetRequest } from './sheet-data'
import {
  columnName,
  type Axis,
  firstCellFrom,
  indexAt,
  makeAxis,
  mergesIn,
  cellText,
  sizeOf,
  startOf,
  textAt,
} from './sheet-layout'
import SheetWorker from './sheet-worker?worker'
import './sheet-viewer.css'

const DEFAULT_COL = 64
const DEFAULT_ROW = 20
const HEAD_HEIGHT = 22
/** A short sheet still fills the pane as a sheet does. */
const MIN_ROWS = 60
const MIN_COLS = 16
/** Rows and columns drawn beyond the view, so a scroll shows no blank edge before it catches up. */
const OVERSCAN = 4
/** What is drawn changes only a chunk at a time, as every change to the page costs a restyle. */
const ROW_CHUNK = 24
const COL_CHUNK = 4

/** Where each sheet was left, so another tab and back finds the place it was at. */
const positions = new Map<string, { top: number; left: number }>()

/**
 * A workbook's visible sheets, one tab each, drawn as a grid of the cells' shown text. The file
 * is parsed in a worker; the grid draws only the rows and columns in view, so a sheet of a
 * hundred thousand rows scrolls like a short one. A file opened again is a new stage.
 */
export default function SheetStage({
  viewKey,
  url,
  name,
  onFailed,
}: {
  /** What each sheet's place is kept under. */
  viewKey: string
  url: string
  name: string
  onFailed: (failure: DocumentFailure) => void
}) {
  const { t } = useTranslation('files')
  const [sheets, setSheets] = useState<SheetData[]>([])
  const [done, setDone] = useState(false)
  const [active, setActive] = useState(0)
  // The page's handler outlives a render, so it follows the latest one.
  const failed = useRef(onFailed)
  useEffect(() => {
    failed.current = onFailed
  })

  useEffect(() => {
    const reading = new AbortController()
    const worker = new SheetWorker()
    worker.onmessage = ({ data }: MessageEvent<SheetMessage>) => {
      if (data.kind === 'sheet') setSheets((held) => [...held, data.sheet])
      else if (data.kind === 'done') setDone(true)
      else failed.current(data.reason)
    }
    // The worker stopped without an answer, as it does when the workbook outgrows its memory.
    worker.onerror = () => failed.current('invalid')
    readMedia(url, reading.signal).then(
      (bytes) => {
        if (bytes.length > OFFICE_PREVIEW_LIMIT) return failed.current('unreadable')
        worker.postMessage({ bytes } satisfies SheetRequest, [bytes.buffer])
      },
      () => {
        if (!reading.signal.aborted) failed.current('unreadable')
      },
    )
    return () => {
      reading.abort()
      worker.terminate()
    }
  }, [url])

  if (done && sheets.length === 0) {
    return (
      <PaneEmpty
        className="absolute inset-0"
        icon={<PaneIcon icon={File01Icon} size={20} />}
        title={t('preview.sheetsHiddenTitle')}
        text={t('preview.sheetsHiddenDescription')}
      />
    )
  }
  const sheet = sheets[active]
  if (!sheet) return <Lines />
  return (
    <div className="kp-sheet absolute inset-0 flex flex-col" data-selectable="">
      <Tabs
        value={String(active)}
        onValueChange={(next) => setActive(Number(next))}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList
          variant="line"
          aria-label={t('preview.sheets', { name })}
          className="kp-sheet__tabs h-8 w-full shrink-0 justify-start overflow-x-auto px-2 pb-1.5"
        >
          {sheets.map((each, index) => (
            <TabsTrigger key={each.name} value={String(index)} className="flex-none">
              {each.name}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={String(active)} className="relative min-h-0 flex-1">
          <SheetGrid key={sheet.name} sheet={sheet} placeKey={`${viewKey}\0${sheet.name}`} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** The rows and columns drawn, which are the ones in view and a margin around them. */
interface Drawn {
  r0: number
  r1: number
  c0: number
  c1: number
}

function SheetGrid({ sheet, placeKey }: { sheet: SheetData; placeKey: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [drawn, setDrawn] = useState<Drawn | null>(null)
  const layout = useMemo(() => {
    const rows = Math.max(sheet.rows, MIN_ROWS)
    const cols = Math.max(sheet.cols, MIN_COLS)
    return {
      rows: makeAxis(rows, sheet.rowHeights, DEFAULT_ROW),
      cols: makeAxis(cols, sheet.colWidths, DEFAULT_COL),
      headWidth: Math.max(40, String(rows).length * 8 + 20),
    }
  }, [sheet])

  const measure = useCallback(() => {
    const el = box.current
    if (!el) return
    const { rows, cols } = layout
    const first = (axis: Axis, offset: number, chunk: number) =>
      Math.floor(Math.max(0, indexAt(axis, offset) - OVERSCAN) / chunk) * chunk
    const last = (axis: Axis, offset: number, chunk: number) =>
      Math.min(
        axis.count - 1,
        Math.ceil((indexAt(axis, offset) + OVERSCAN + 1) / chunk) * chunk - 1,
      )
    const next: Drawn = {
      r0: first(rows, el.scrollTop, ROW_CHUNK),
      r1: last(rows, el.scrollTop + el.clientHeight, ROW_CHUNK),
      c0: first(cols, el.scrollLeft, COL_CHUNK),
      c1: last(cols, el.scrollLeft + el.clientWidth, COL_CHUNK),
    }
    setDrawn((held) =>
      held &&
      held.r0 === next.r0 &&
      held.r1 === next.r1 &&
      held.c0 === next.c0 &&
      held.c1 === next.c1
        ? held
        : next,
    )
  }, [layout])

  useLayoutEffect(() => {
    const el = box.current
    const saved = positions.get(placeKey)
    if (el && saved) {
      el.scrollTop = saved.top
      el.scrollLeft = saved.left
    }
    measure()
  }, [placeKey, measure])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure])

  const { rows, cols, headWidth } = layout
  const columnHeads: ReactNode[] = []
  const rowHeads: ReactNode[] = []
  const cells: ReactNode[] = []
  if (drawn) {
    const { r0, r1, c0, c1 } = drawn
    const merges = mergesIn(sheet, r0, r1, c0, c1)
    for (let c = c0; c <= c1; c++) {
      if (sizeOf(cols, c) === 0) continue
      columnHeads.push(
        <div
          key={c}
          className="kp-sheet__head"
          style={{
            left: headWidth + startOf(cols, c),
            width: sizeOf(cols, c),
            height: HEAD_HEIGHT,
          }}
        >
          {columnName(c)}
        </div>,
      )
    }
    for (let r = r0; r <= r1; r++) {
      const height = sizeOf(rows, r)
      if (height === 0) continue
      const top = HEAD_HEIGHT + startOf(rows, r)
      rowHeads.push(
        <div
          key={r}
          className="kp-sheet__head kp-sheet__head--row"
          style={{ top, width: headWidth, height }}
        >
          {r + 1}
        </div>,
      )
      let next = r < sheet.rows ? firstCellFrom(sheet, r, c0) : 0
      const end = r < sheet.rows ? sheet.rowStart[r + 1]! : 0
      for (let c = c0; c <= c1; c++) {
        const width = sizeOf(cols, c)
        if (width === 0) continue
        const held = next < end && sheet.cellCol[next] === c ? next++ : -1
        if (merges.some((m) => r >= m[0] && r <= m[2] && c >= m[1] && c <= m[3])) continue
        cells.push(
          <div
            key={`${r}:${c}`}
            className="kp-sheet__cell"
            data-kind={held < 0 ? undefined : sheet.cellKind[held]}
            style={{ left: headWidth + startOf(cols, c), top, width, height }}
          >
            {held < 0 ? null : cellText(sheet, held)}
          </div>,
        )
      }
    }
    for (const [r, c, r2, c2] of merges) {
      const text = textAt(sheet, r, c)
      const index = r < sheet.rows ? firstCellFrom(sheet, r, c) : 0
      cells.push(
        <div
          key={`m${r}:${c}`}
          className="kp-sheet__cell"
          data-kind={text === null ? undefined : sheet.cellKind[index]}
          style={{
            left: headWidth + startOf(cols, c),
            top: HEAD_HEIGHT + startOf(rows, r),
            width: startOf(cols, c2 + 1) - startOf(cols, c),
            height: startOf(rows, r2 + 1) - startOf(rows, r),
          }}
        >
          {text}
        </div>,
      )
    }
  }

  return (
    <div
      ref={box}
      tabIndex={0}
      role="group"
      aria-label={sheet.name}
      className="kp-sheet__scroll"
      onScroll={(event) => {
        const { scrollTop, scrollLeft } = event.currentTarget
        positions.set(placeKey, { top: scrollTop, left: scrollLeft })
        measure()
      }}
    >
      <div
        className="kp-sheet__sizer"
        style={{ width: headWidth + cols.total, height: HEAD_HEIGHT + rows.total }}
      >
        <div className="kp-sheet__cells">{cells}</div>
        <div className="kp-sheet__bar kp-sheet__bar--top">{columnHeads}</div>
        <div className="kp-sheet__bar kp-sheet__bar--left" style={{ width: headWidth }}>
          {rowHeads}
        </div>
        <div className="kp-sheet__corner" style={{ width: headWidth, height: HEAD_HEIGHT }} />
      </div>
    </div>
  )
}
