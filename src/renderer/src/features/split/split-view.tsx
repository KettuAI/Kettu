import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { SHEET_PANEL } from '@renderer/features/shell/sheet'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import {
  setColumnShares,
  setPaneShares,
  setVisiblePanes,
  useViewStore,
} from '@renderer/stores/view'
import {
  allPanes,
  MIN_COLUMN_WIDTH,
  MIN_PANE_HEIGHT,
  NOTHING_SHOWN,
  findPane,
  isSplit,
  visibleLayout,
  visibleSizes,
  type FoldedBefore,
  type Layout,
  type Pane,
} from './layout'
import { Pane as PaneFrame } from './pane'
import { PaneContent } from './pane-content'
import { DropHint } from './session-drag'
import { registerSplitBox } from './session-drag-model'

/**
 * The main area while sessions show: the split's columns and panes, folded to the room it has,
 * with the drop hint over the room a dragged session will take.
 */
// The panes the split has drawn: one it has not, as a drop adds it, fades in.
const drawn = new Set<string>(allPanes(useViewStore.getState().layout).map((pane) => pane.id))

export function SplitView() {
  const layout = useViewStore((s) => s.layout)
  const visiblePanes = useViewStore((s) => s.visiblePanes)
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    registerSplitBox(box.current)
    return () => registerSplitBox(null)
  }, [])

  // The split measures its own box, which lies beside the side panel when that is open.
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry?.contentRect
      if (rect) setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // What showed last is the run kept while it still holds the focus.
  const previous = useMemo(() => shownBefore(layout, visiblePanes), [layout, visiblePanes])
  const folded = size ? visibleLayout(layout, size, previous) : null
  const sizes = folded ? visibleSizes(layout, folded) : null
  const shown = folded?.panes.join(',') ?? ''

  useEffect(() => {
    setVisiblePanes(shown ? shown.split(',') : [])
  }, [shown])

  return (
    <div ref={box} data-split-root="" className="relative h-full min-h-0 w-full">
      {folded && sizes && (
        <>
          <ResizablePanelGroup
            // Rebuilt when its columns change: a default layout is read once.
            key={`columns:${folded.columns.map((column) => column.id).join(',')}`}
            orientation="horizontal"
            defaultLayout={sizes.columns}
            onLayoutChanged={setColumnShares}
            className="h-full min-h-0"
          >
            {folded.columns.map((column, index) => (
              <Column
                key={column.id}
                layout={layout}
                columnId={column.id}
                panes={column.panes}
                sizes={sizes.panes}
                first={index === 0}
                split={isSplit(layout)}
              />
            ))}
          </ResizablePanelGroup>
          <DropHint />
        </>
      )}
    </div>
  )
}

function Column({
  layout,
  columnId,
  panes,
  sizes,
  first,
  split,
}: {
  layout: Layout
  columnId: string
  panes: string[]
  sizes: Record<string, number>
  /** The first column in view, whose top pane leaves room for the traffic lights. */
  first: boolean
  split: boolean
}) {
  const found = panes.flatMap((paneId) => {
    const pane = findPane(layout, paneId)
    return pane ? [pane] : []
  })
  return (
    <>
      {!first && <ResizableHandle withHandle className="bg-border" />}
      <ResizablePanel
        id={columnId}
        minSize={`${MIN_COLUMN_WIDTH}px`}
        style={SHEET_PANEL}
        className="min-w-0"
      >
        {found.length === 1 ? (
          <Frame layout={layout} pane={found[0]!} split={split} cornered={first} />
        ) : (
          // The panes of a column, with the desk between two of them to resize them.
          <ResizablePanelGroup
            key={`column:${columnId}:${panes.join(',')}`}
            orientation="vertical"
            defaultLayout={defaultsOf(panes, sizes)}
            onLayoutChanged={(next) => setPaneShares(columnId, next)}
            className="h-full min-h-0"
          >
            {found.map((pane, index) => (
              <PanePanel key={pane.id} last={index === found.length - 1}>
                <Frame layout={layout} pane={pane} split={split} cornered={first && index === 0} />
              </PanePanel>
            ))}
          </ResizablePanelGroup>
        )}
      </ResizablePanel>
    </>
  )
}

function PanePanel({ last, children }: { last: boolean; children: ReactNode }) {
  return (
    <>
      <ResizablePanel minSize={`${MIN_PANE_HEIGHT}px`} className="min-w-0">
        {children}
      </ResizablePanel>
      {!last && <ResizableHandle withHandle className="bg-border" />}
    </>
  )
}

function Frame({
  layout,
  pane,
  split,
  cornered,
}: {
  layout: Layout
  pane: Pane
  split: boolean
  cornered: boolean
}) {
  const name = usePaneName(pane)
  const fresh = !drawn.has(pane.id)
  if (fresh) drawn.add(pane.id)
  return (
    <PaneFrame
      paneId={pane.id}
      view={pane.view}
      name={name}
      focused={layout.focus === pane.id}
      split={split}
      cornered={cornered}
      fresh={fresh}
    >
      <PaneContent paneId={pane.id} />
    </PaneFrame>
  )
}

/** A pane's name for assistive technology: its session's title, or New session. */
function usePaneName(pane: Pane): string {
  const { t } = useTranslation('session')
  const summary = useSessionsStore((s) =>
    pane.view.kind === 'session' ? s.byId[pane.view.sessionId] : undefined,
  )
  if (pane.view.kind === 'new') return t('newSession.title')
  return summary ? sessionTitle(summary) : t('newSession.title')
}

function defaultsOf(panes: string[], sizes: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const paneId of panes) out[paneId] = sizes[paneId] ?? 100 / panes.length
  return out
}

/** The run shown last, from the panes in view, so the room that comes back shows them again. */
function shownBefore(layout: Layout, visiblePanes: string[]): FoldedBefore {
  const before: FoldedBefore = { columns: [], panes: {} }
  if (visiblePanes.length === 0) return NOTHING_SHOWN
  for (const column of layout.columns) {
    const panes = column.panes
      .map((pane) => pane.id)
      .filter((paneId) => visiblePanes.includes(paneId))
    if (panes.length === 0) continue
    before.columns.push(column.id)
    before.panes[column.id] = panes
  }
  return before.columns.length === 0 ? NOTHING_SHOWN : before
}
