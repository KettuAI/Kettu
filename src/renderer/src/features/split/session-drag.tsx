import { useEffect, useRef } from 'react'
import {
  DragDropProvider,
  DragOverlay,
  PointerSensor,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/react'
import { BotIcon } from '@hugeicons/core-free-icons'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Glyph } from '@renderer/features/shell/glyph'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { dropViewAt } from '@renderer/stores/view'
import {
  splitSize,
  dragEnded,
  dragMoved,
  dragStarted,
  useSessionDragStore,
  viewOf,
  type SessionDragData,
} from './session-drag-model'
import type { Box } from './layout'

const pointerDefaults = PointerSensor.defaults.activationConstraints
const sensors = [
  PointerSensor.configure({
    activationConstraints: (event, source) => {
      const constraints =
        typeof pointerDefaults === 'function' ? pointerDefaults(event, source) : pointerDefaults
      // Mouse defaults are [Delay, Distance]; keep only Distance so a hold remains a click.
      return event.pointerType === 'mouse' ? constraints?.slice(1) : constraints
    },
  }),
]

const pointerOf = (event: DragStartEvent | DragMoveEvent | DragEndEvent) => {
  const { x, y } = event.operation.position.current
  return { x, y }
}

/** The drag provider around the sidebar and the main area, with the chip under the pointer. */
export function SplitDragProvider({ children }: { children: React.ReactNode }) {
  const start = (event: DragStartEvent) => {
    const data = event.operation.source?.data as SessionDragData | undefined
    if (data?.sessionId) dragStarted(data, pointerOf(event))
  }
  const move = (event: DragMoveEvent) => {
    // The operation's position is still the one before this move; the move's own is `to`.
    dragMoved(event.to ?? pointerOf(event))
  }
  const end = (event: DragEndEvent) => {
    const drop = dragEnded(event.canceled)
    const size = splitSize()
    if (!drop || !size) return
    const view = viewOf(drop.data)
    if (view) dropViewAt(view, drop.place, size)
  }
  return (
    <DragDropProvider sensors={sensors} onDragStart={start} onDragMove={move} onDragEnd={end}>
      {children}
      <DragOverlay dropAnimation={null}>
        <SessionChip sessionId={useSessionDragStore((s) => s.dragging?.sessionId)} />
      </DragOverlay>
    </DragDropProvider>
  )
}

function SessionChip({ sessionId }: { sessionId: string | undefined }) {
  const summary = useSessionsStore((s) => (sessionId ? s.byId[sessionId] : undefined))
  if (!summary) return null
  return (
    <div className="flex h-8 max-w-60 items-center gap-[9px] rounded-lg bg-surface py-1.5 pr-2.5 pl-2 text-ui text-primary shadow-menu">
      {summary.origin === 'subagent' ? (
        <Glyph icon={BotIcon} size={14} className="shrink-0 text-secondary" />
      ) : (
        <AgentMark agent={summary.agentId} size={14} hostId={hostOfSession(summary)} />
      )}
      <span className="min-w-0 truncate">{sessionTitle(summary)}</span>
    </div>
  )
}

/** The room the drop marked, over the panes, in the split's own coordinates. */
export function DropHint() {
  const drop = useSessionDragStore((s) => s.drop)
  const ref = useRef<HTMLDivElement>(null)
  const box: Box | null = drop?.box ?? null
  useEffect(() => {
    const element = ref.current
    const parent = element?.offsetParent?.getBoundingClientRect()
    if (!element || !parent || !box) return
    element.style.transform = `translate(${box.left - parent.left}px, ${box.top - parent.top}px)`
    element.style.width = `${box.right - box.left}px`
    element.style.height = `${box.bottom - box.top}px`
  }, [box])
  if (!box) return null
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 z-20 animate-in rounded-card bg-selection fade-in ring-1 ring-focus animation-duration-(--duration-fast)"
    />
  )
}
