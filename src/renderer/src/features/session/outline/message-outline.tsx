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
import { GlideHighlight } from '@renderer/components/glide-highlight'
import { HoverCard, HoverCardContent } from '@renderer/components/ui/hover-card'
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
// Resting on one message this long opens the full list beside the rail.
const LIST_AFTER_MS = 500
// How long the list stays once the pointer has left both it and the rail.
const LIST_CLOSE_MS = 220
// The list's rows have a fixed height, so the pointed row can be placed beside its dash at once.
const LIST_ROW = 32
const LIST_PAD = 5
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
  // The full list, opened by resting on a message or leaving towards its preview. Its place stays
  // after it closes, so it fades out where it was.
  const [listOpen, setListOpen] = useState(false)
  const [place, setPlace] = useState<ListPlace | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  const previewBox = useRef<HTMLDivElement | null>(null)
  const onRail = useRef(false)
  const listTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      for (const timer of [previewTimer, foldTimer, listTimer, closeTimer])
        clearTimeout(timer.current)
    },
    [],
  )
  const [preview] = useState(() => TooltipPrimitive.createHandle())
  const ids = useId()
  // The preview glides from dash to dash only once it is in place, or it would glide in from a corner.
  const [glide, setGlide] = useState(false)
  const previewOpen = previewing && at !== null && !listOpen
  useEffect(() => {
    if (!previewOpen) return
    const timer = setTimeout(() => setGlide(true), GLIDE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [previewOpen])

  useLayoutEffect(() => {
    if (listOpen && place && list.current) list.current.scrollTop = place.scroll
  }, [listOpen, place])
  // Pointing along the rail keeps the pointed row in sight; in the list the row is under the pointer.
  useEffect(() => {
    const view = list.current
    if (!listOpen || at === null || !view || !onRail.current) return
    const top = LIST_PAD + at * LIST_ROW
    if (top - LIST_PAD < view.scrollTop) view.scrollTop = top - LIST_PAD
    else if (top + LIST_ROW + LIST_PAD > view.scrollTop + view.clientHeight)
      view.scrollTop = top + LIST_ROW + LIST_PAD - view.clientHeight
  }, [listOpen, at])

  const fold = (): void => {
    clearTimeout(previewTimer.current)
    clearTimeout(listTimer.current)
    setAt(null)
    setPreviewing(false)
    setGlide(false)
    foldTimer.current = setTimeout(() => setAnchor(null), FOLD_AFTER_MS)
  }
  const closeList = (): void => {
    clearTimeout(closeTimer.current)
    setListOpen(false)
    if (!onRail.current) fold()
  }
  const leaveList = (): void => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(closeList, LIST_CLOSE_MS)
  }

  const jump = (row: OutlineRow): void => {
    void jumpTo(
      { entryId: row.entryId, pos: row.pos },
      {
        onRevealed: () => {
          setOpen(false)
          closeList()
        },
      },
    )
  }

  if (rows.length < 2 || !room || height === 0) return null
  const dashes = dashCount(rows.length, height)
  const readingDash = dashOf(readingIndex, rows.length, dashes)
  const pointedDash = at === null ? null : dashOf(at, rows.length, dashes)
  const shownRow = rows[Math.min(shown, rows.length - 1)]!
  const spread = anchor !== null
  const restHeight = dashOffset(dashes - 1, dashes, null) - dashOffset(0, dashes, null)

  const maxList = Math.round(height * 0.6)
  // Opens the list with the row of `index` level with its dash, scrolled as little as that needs.
  const openList = (index: number): void => {
    const dash = document.getElementById(`${ids}-${dashOf(index, rows.length, dashes)}`)
    if (!dash) return
    const total = 2 * LIST_PAD + rows.length * LIST_ROW
    const visible = Math.min(total, maxList)
    const center = LIST_PAD + index * LIST_ROW + LIST_ROW / 2
    const scroll = Math.min(Math.max(0, center - visible / 2), total - visible)
    clearTimeout(listTimer.current)
    setPlace({ dash, offset: dash.offsetHeight / 2 - (center - scroll), scroll })
    setListOpen(true)
  }

  const below = (clientY: number): number =>
    clientY - (rail.current?.getBoundingClientRect().top ?? 0)
  const point = (clientY: number, around: number): void => {
    const next = messageAt(below(clientY), rows.length, dashes, around)
    if (next !== at && !listOpen) {
      clearTimeout(listTimer.current)
      listTimer.current = setTimeout(() => openList(next), LIST_AFTER_MS)
    }
    setAt(next)
    setShown(next)
  }
  const onPointerEnter = (event: ReactPointerEvent): void => {
    onRail.current = true
    clearTimeout(foldTimer.current)
    clearTimeout(closeTimer.current)
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
  const onPointerLeave = (event: ReactPointerEvent): void => {
    onRail.current = false
    // Leaving to the right across the preview's height heads onto the preview, so the list opens.
    const right = rail.current?.getBoundingClientRect().right ?? Infinity
    const box = previewBox.current?.getBoundingClientRect()
    const towards =
      !!box && event.clientX >= right - 1 && event.clientY >= box.top && event.clientY <= box.bottom
    if (!listOpen && previewOpen && at !== null && towards) openList(at)
    else if (!listOpen) return fold()
    clearTimeout(previewTimer.current)
    clearTimeout(listTimer.current)
    leaveList()
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
          ref={previewBox}
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
      <HoverCard
        open={listOpen}
        onOpenChange={(next) => {
          if (!next) closeList()
        }}
      >
        <HoverCardContent
          ref={list}
          anchor={place?.dash}
          side="right"
          align="start"
          alignOffset={place?.offset ?? 0}
          sideOffset={4}
          className="relative w-70 overflow-y-auto p-1.25"
          style={{ maxHeight: maxList }}
          onPointerEnter={() => clearTimeout(closeTimer.current)}
          onPointerLeave={leaveList}
        >
          <GlideHighlight />
          {rows.map((row, i) => (
            <button
              key={row.entryId}
              type="button"
              tabIndex={-1}
              data-highlighted={i === at || undefined}
              data-reading={i === readingIndex || undefined}
              className="ks-outline__item relative flex h-8 w-full cursor-default items-center gap-2.5 rounded-lg text-left outline-hidden select-none"
              onPointerEnter={() => {
                setAt(i)
                setShown(i)
              }}
              onClick={() => jump(row)}
            >
              <span className="min-w-0 flex-1 truncate">
                {row.label || t('thread.outline.noText')}
              </span>
              {waiting === row.entryId && (
                <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
              )}
            </button>
          ))}
        </HoverCardContent>
      </HoverCard>
    </>
  )
})

/** Where the list opens: beside `dash`, shifted by `offset` and scrolled to `scroll`. */
interface ListPlace {
  dash: HTMLElement
  offset: number
  scroll: number
}

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
