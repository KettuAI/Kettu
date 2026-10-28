import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'
import { focusPane } from '@renderer/stores/view'
import { SHEET } from '@renderer/features/shell/sheet'
import type { PaneView } from './layout'
import { PaneContext } from './pane-context'
import { registerPaneBox } from './session-drag-model'

/**
 * One pane of the split: its own sheet, named by its session's title, which takes the focus on a
 * press or a focus event inside it, and gives the components in it their pane's view.
 */
export function Pane({
  paneId,
  view,
  name,
  focused,
  split,
  cornered,
  fresh = false,
  className,
  children,
}: {
  paneId: string
  view: PaneView
  name: string
  focused: boolean
  /** Whether the main area shows more than one pane. */
  split: boolean
  /** The top pane of the first column in view, which leaves room for the traffic lights. */
  cornered: boolean
  /** A pane the split has just gained, which fades in; one restored at launch does not. */
  fresh?: boolean
  className?: string
  children: ReactNode
}) {
  const element = useRef<HTMLDivElement>(null)

  useEffect(() => {
    registerPaneBox(paneId, element.current)
    return () => registerPaneBox(paneId, null)
  }, [paneId])

  return (
    <div
      ref={element}
      data-split-pane={paneId}
      role="region"
      aria-label={name}
      // The capture phase, so a press on a toggle, a permission card or the composer is the pane's.
      onPointerDownCapture={() => focusPane(paneId)}
      onFocusCapture={() => focusPane(paneId)}
      className={cn(
        'h-full min-h-0 min-w-0',
        SHEET,
        split && focused && 'shadow-sheet-focused',
        fresh && 'animate-in fade-in animation-duration-(--duration-fast)',
        className,
      )}
    >
      <PaneContext value={{ paneId, view, focused, cornered, split }}>{children}</PaneContext>
    </div>
  )
}
