import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Spinner } from '@renderer/components/ui/spinner'
import type { ThreadJumps } from '../thread'
import { dashCount, dashOf, ReadingTracker } from './rail'
import { useJumpToMessage } from './use-jump'
import { useOutline, type OutlineRow } from './use-outline'

// Less room than this between the viewport's edge and the column's text hides the rail.
const ROOM_PX = 40
// A first row focused this soon after opening was focused by the keyboard opening.
const KEYBOARD_FOCUS_MS = 500

/** The viewport's height, and whether the column leaves the rail its room. */
function useRailBox(
  viewport: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
): { height: number; room: boolean } {
  const [box, setBox] = useState({ height: 0, room: false })
  useEffect(() => {
    const view = viewport.current
    const column = content.current
    if (!view || !column) return
    const measure = (): void => {
      const inset = Number.parseFloat(getComputedStyle(column).paddingLeft) || 0
      const text = column.getBoundingClientRect().left + inset - view.getBoundingClientRect().left
      const next = { height: view.clientHeight, room: text >= ROOM_PX }
      setBox((current) =>
        current.height === next.height && current.room === next.room ? current : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    return () => observer.disconnect()
  }, [viewport, content])
  return box
}

/**
 * The message outline: a rail of dashes at the thread's left edge, one per user message with the
 * reading position marked, that opens into a list of them to jump between.
 */
export const MessageOutline = memo(function MessageOutline({
  sessionId,
  viewport,
  content,
  jumps,
}: {
  sessionId: string
  viewport: RefObject<HTMLDivElement | null>
  content: RefObject<HTMLDivElement | null>
  jumps: ThreadJumps
}) {
  const { t } = useTranslation('session')
  const { rows, opened } = useOutline(sessionId)
  const { height, room } = useRailBox(viewport, content)
  const { jumpTo, waiting } = useJumpToMessage(sessionId, viewport, content, jumps)

  const [tracker] = useState(() => new ReadingTracker())
  useEffect(() => {
    const view = viewport.current
    const column = content.current
    if (!view || !column) return
    tracker.attach(view, column)
    return () => tracker.detach()
  }, [tracker, viewport, content])
  useEffect(() => {
    tracker.setMessages(rows.map((row) => row.entryId))
  }, [tracker, rows])
  const reading = useSyncExternalStore(tracker.subscribe, tracker.get)
  const readingIndex = Math.max(
    0,
    rows.findIndex((row) => row.entryId === reading),
  )

  const [open, setOpen] = useState(false)

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (next) opened()
  }

  const jump = (row: OutlineRow): void => {
    void jumpTo({ entryId: row.entryId, pos: row.pos }, { onRevealed: () => setOpen(false) })
  }

  // The list opens scrolled to the reading position. A keyboard opening highlights its first row,
  // which is moved to the reading position; a pointer that comes in later highlights what it is on.
  const popup = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const openedAt = performance.now()
    const reading = (): HTMLElement | null =>
      popup.current?.querySelector<HTMLElement>('[data-reading]') ?? null
    const frame = requestAnimationFrame(() => {
      const list = popup.current
      const row = reading()
      if (list && row) list.scrollTop = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2
    })
    const onFocus = (event: FocusEvent): void => {
      const first = popup.current?.querySelector('[role=menuitem]')
      const row = reading()
      if (event.target !== first || !row || row === first) return
      if (performance.now() - openedAt > KEYBOARD_FOCUS_MS) return
      row.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', onFocus)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open])

  if (rows.length < 2 || !room || height === 0) return null
  const dashes = dashCount(rows.length, height)
  const readingDash = dashOf(readingIndex, rows.length, dashes)

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger
        openOnHover
        delay={150}
        closeDelay={300}
        aria-label={t('thread.outline.label', { count: rows.length })}
        className="ks-outline absolute top-1/2 left-3.5 z-10 -translate-y-1/2 focus-ring rounded-md"
      >
        {Array.from({ length: dashes }, (_, i) => (
          <span
            key={i}
            aria-hidden
            data-current={i === readingDash || undefined}
            className="ks-outline__dash"
          />
        ))}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={popup}
        side="right"
        align="center"
        className="w-70"
        style={{ maxHeight: Math.round(height * 0.6) }}
      >
        {rows.map((row, i) => (
          <OutlineItem
            key={row.entryId}
            label={row.label}
            reading={i === readingIndex}
            waiting={waiting === row.entryId}
            onJump={() => jump(row)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

function OutlineItem({
  label,
  reading,
  waiting,
  onJump,
}: {
  label: string
  reading: boolean
  waiting: boolean
  onJump: () => void
}) {
  return (
    <DropdownMenuItem
      closeOnClick={false}
      onClick={onJump}
      data-reading={reading || undefined}
      className="ks-outline__item"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {waiting && <Spinner className="size-3.5 shrink-0 text-muted-foreground" />}
    </DropdownMenuItem>
  )
}
