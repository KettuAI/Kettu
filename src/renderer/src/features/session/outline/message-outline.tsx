import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import type { ThreadJumps } from '../thread'
import { dashCount, dashOf, dashOffset, messageAt, ReadingTracker, restDashAt } from './rail'
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

// How long the pointer rests on the rail before its message shows, so passing over it shows none.
const PREVIEW_AFTER_MS = 80
// How long after the preview opens it is in place and may glide between dashes.
const GLIDE_AFTER_MS = 60
// How long the rail stays open after the pointer leaves, so leaving it by a pixel does not fold it.
const FOLD_AFTER_MS = 160
// Dash lengths: at rest, under the pointer and stepping down beside it, and while open.
const REST_LENGTH = 8
const READING_LENGTH = 14
const OPEN_LENGTHS = [20, 15, 12]
const OPEN_LENGTH = 10
const LONGEST = OPEN_LENGTHS[0]!
// The keyboard's focus ring reaches this far around the rail at rest.
const KEYS_INSET = 6

function dashLength(open: boolean, distance: number | null, reading: boolean): number {
  const length = !open
    ? REST_LENGTH
    : distance === null
      ? OPEN_LENGTH
      : (OPEN_LENGTHS[distance] ?? OPEN_LENGTH)
  return reading ? Math.max(length, READING_LENGTH) : length
}

/**
 * The message outline: a rail of dashes at the thread's left edge, one per user message with the
 * reading position marked. It spreads when the pointer comes onto it, shows the message under the
 * pointer and jumps there on a click; from the keyboard it opens a list of them.
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

  // The pointer on the rail: the dash it spread around, the message under it, and the last one
  // shown, which the preview keeps while it fades out.
  const rail = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<number | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const [shown, setShown] = useState(0)
  const [previewing, setPreviewing] = useState(false)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const foldTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      clearTimeout(previewTimer.current)
      clearTimeout(foldTimer.current)
    },
    [],
  )
  const [preview] = useState(() => TooltipPrimitive.createHandle())
  const ids = useId()
  // The preview glides from dash to dash only once it is in place, or it would glide in from a corner.
  const [glide, setGlide] = useState(false)
  const previewOpen = previewing && at !== null
  useEffect(() => {
    if (!previewOpen) return
    const timer = setTimeout(() => setGlide(true), GLIDE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [previewOpen])

  if (rows.length < 2 || !room || height === 0) return null
  const dashes = dashCount(rows.length, height)
  const readingDash = dashOf(readingIndex, rows.length, dashes)
  const pointedDash = at === null ? null : dashOf(at, rows.length, dashes)
  const shownRow = rows[Math.min(shown, rows.length - 1)]!
  const spread = anchor !== null
  const restHeight = dashOffset(dashes - 1, dashes, null) - dashOffset(0, dashes, null)

  const below = (clientY: number): number =>
    clientY - (rail.current?.getBoundingClientRect().top ?? 0)
  const point = (clientY: number, around: number): void => {
    const next = messageAt(below(clientY), rows.length, dashes, around)
    setAt(next)
    setShown(next)
  }
  const onPointerEnter = (event: ReactPointerEvent): void => {
    clearTimeout(foldTimer.current)
    const around = anchor ?? restDashAt(below(event.clientY), dashes)
    setAnchor(around)
    point(event.clientY, around)
    if (!previewing) {
      previewTimer.current = setTimeout(() => {
        setPreviewing(true)
        opened()
      }, PREVIEW_AFTER_MS)
    }
  }
  const onPointerMove = (event: ReactPointerEvent): void => {
    if (anchor !== null) point(event.clientY, anchor)
  }
  const onPointerLeave = (): void => {
    clearTimeout(previewTimer.current)
    setAt(null)
    setPreviewing(false)
    setGlide(false)
    foldTimer.current = setTimeout(() => setAnchor(null), FOLD_AFTER_MS)
  }

  return (
    <>
      <div
        ref={rail}
        data-open={spread || undefined}
        className="ks-outline absolute top-1/2 left-0 z-10"
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onClick={() => {
          if (at !== null) jump(rows[at]!)
        }}
      >
        {Array.from({ length: dashes }, (_, i) => {
          const distance = pointedDash === null ? null : Math.abs(i - pointedDash)
          return (
            <TooltipTrigger
              key={i}
              id={`${ids}-${i}`}
              handle={preview}
              render={<span />}
              aria-hidden
              data-current={i === readingDash || undefined}
              data-pointed={distance === 0 || undefined}
              data-near={distance === 1 || undefined}
              className="ks-outline__row"
              style={{ transform: `translateY(${dashOffset(i, dashes, anchor)}px)` }}
            >
              <span
                className="ks-outline__dash"
                style={{
                  transform: `scaleX(${dashLength(spread, distance, i === readingDash) / LONGEST})`,
                }}
              />
            </TooltipTrigger>
          )
        })}
        <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
          <DropdownMenuTrigger
            aria-label={t('thread.outline.label', { count: rows.length })}
            className="ks-outline__keys focus-ring"
            style={{
              top: dashOffset(0, dashes, null) - KEYS_INSET,
              height: restHeight + 2 * KEYS_INSET,
            }}
          />
          <DropdownMenuContent
            ref={popup}
            anchor={rail}
            side="right"
            align="center"
            sideOffset={28}
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
      </div>
      <Tooltip
        handle={preview}
        open={previewOpen}
        triggerId={`${ids}-${dashOf(Math.min(shown, rows.length - 1), rows.length, dashes)}`}
      >
        <TooltipContent
          side="right"
          sideOffset={2}
          positionerClassName={glide ? 'ks-outline__glide' : undefined}
          className="ks-outline__preview"
        >
          <span className="min-w-0 flex-1 line-clamp-2">
            {shownRow.label || t('thread.outline.noText')}
          </span>
          {waiting === shownRow.entryId ? (
            <Spinner className="size-3 shrink-0" />
          ) : (
            <span className="ks-outline__count">
              {shown + 1}/{rows.length}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </>
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
