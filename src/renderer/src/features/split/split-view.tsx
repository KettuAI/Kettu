import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { SHEET_PANEL } from '@renderer/features/shell/sheet'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { setSplitShares, setVisiblePanes, useViewStore } from '@renderer/stores/view'
import {
  allPanes,
  cornerPane,
  isSplit,
  shownMinLength,
  visibleLayout,
  type Layout,
  type Pane,
  type ShownNode,
} from './layout'
import { Pane as PaneFrame } from './pane'
import { PaneContent } from './pane-content'
import { DropHint } from './session-drag'
import { registerSplitBox } from './session-drag-model'

/**
 * The main area while sessions show: the split's tree of panes, folded to the room it has, with
 * the drop hint over the room a dragged session will take.
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

  // What showed last is kept, while it still fits around the focus.
  const visible = useMemo(
    () => (size ? visibleLayout(layout, size, visiblePanes) : null),
    [layout, size, visiblePanes],
  )
  const shown = visible?.panes.join(',') ?? ''

  useEffect(() => {
    setVisiblePanes(shown ? shown.split(',') : [])
  }, [shown])

  return (
    <div ref={box} data-split-root="" className="relative h-full min-h-0 w-full">
      {visible && (
        <>
          <Part
            node={visible.root}
            layout={layout}
            split={isSplit(layout)}
            corner={cornerPane(visible.root)}
          />
          <DropHint />
        </>
      )}
    </div>
  )
}

/** A shown part of the split: a pane, or a group of parts with the desk between two to resize. */
function Part({
  node,
  layout,
  split,
  corner,
}: {
  node: ShownNode
  layout: Layout
  split: boolean
  /** The pane at the top left, which leaves room for the traffic lights. */
  corner: string
}) {
  if (node.kind === 'pane') {
    return (
      <Frame layout={layout} pane={node.pane} split={split} cornered={node.pane.id === corner} />
    )
  }
  const row = node.direction === 'row'
  return (
    <ResizablePanelGroup
      // Rebuilt when its parts change: a default layout is read once.
      key={`split:${node.id}:${node.children.map((child) => child.slot).join(',')}`}
      orientation={row ? 'horizontal' : 'vertical'}
      defaultLayout={Object.fromEntries(node.children.map((child) => [child.slot, child.size]))}
      onLayoutChanged={(sizes) => setSplitShares(node.id, sizes)}
      className="h-full min-h-0"
      style={SHEET_PANEL}
    >
      {node.children.map((child, index) => (
        <Fragment key={child.slot}>
          {index > 0 && (
            <ResizableHandle
              withHandle
              // The handle lies on the desk, which drags the window. The handle's own height for a
              // stacked split is set under the same variant.
              className={`app-region-no-drag ${row ? 'w-(--sheet-gap)' : 'aria-[orientation=horizontal]:h-(--sheet-gap)'}`}
            />
          )}
          <ResizablePanel
            id={child.slot}
            minSize={`${shownMinLength(child, node.direction)}px`}
            style={SHEET_PANEL}
            className="min-w-0"
          >
            <Part node={child} layout={layout} split={split} corner={corner} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
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
