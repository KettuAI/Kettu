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
import { useMessageScroller } from '@renderer/components/ui/message-scroller'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { loadThrough, useThreadsStore } from '@renderer/stores/threads'
import type { ThreadJumps } from '../thread'
import { dashCount, dashOf, ReadingTracker } from './rail'
import { useOutline, type OutlineRow } from './use-outline'

// Less room than this between the viewport's edge and the column's text hides the rail.
const ROOM_PX = 40
// A row shows the spinner only for a jump that waits this long for its pages.
const SPINNER_AFTER_MS = 200

// The Session start row's key while it waits.
const START = 'start'
// A first row focused this soon after opening was focused by the keyboard opening.
const KEYBOARD_FOCUS_MS = 500
// How many times a jump's scroll is set right before it is left as it is.
const SETTLE_PASSES = 3
// A scroll that sends no scrollend, as one already in place, is taken as ended after this.
const SCROLL_END_MS = 1500

const scrollEnd = (view: HTMLElement): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      view.removeEventListener('scrollend', done)
      resolve()
    }
    const timer = setTimeout(done, SCROLL_END_MS)
    view.addEventListener('scrollend', done)
  })

const reducedMotion = (): boolean =>
  document.documentElement.dataset.reduceMotion === 'always' ||
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

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
  const { scrollToMessage, scrollToStart } = useMessageScroller()

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
  // The row whose pages a jump waits for, once it has waited long enough to say so.
  const [waiting, setWaiting] = useState<string | null>(null)
  const jumping = useRef(0)
  useEffect(
    () => () => {
      jumping.current++
    },
    [],
  )

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (next) opened()
  }

  const jump = async (row: OutlineRow | null): Promise<void> => {
    const view = viewport.current
    const column = content.current
    if (!view || !column) return
    const id = ++jumping.current
    const current = (): boolean => jumping.current === id
    const timer = setTimeout(() => {
      if (current()) setWaiting(row?.entryId ?? START)
    }, SPINNER_AFTER_MS)
    try {
      const replica = useThreadsStore.getState().replicas[sessionId]
      const loaded = row
        ? replica?.state?.byId[row.entryId] !== undefined
        : (replica?.older ?? null) === null
      if (!loaded && !(await loadThrough(sessionId, row?.pos ?? 0))) return
      if (!current()) return
      await jumps.reveal(row?.entryId ?? null)
    } finally {
      clearTimeout(timer)
      if (current()) setWaiting(null)
    }
    if (!current()) return
    setOpen(false)
    jumps.hold(true)
    try {
      await settle(view, column, row?.entryId ?? null, current)
    } finally {
      if (current()) jumps.hold(false)
    }
  }

  /**
   * Scrolls the target to its place and keeps it there: items above it keep an estimated height
   * until they render, so a long smooth scroll can land off, and is set right once it ends. A
   * scroll of the reader's own ends it.
   */
  const settle = async (
    view: HTMLElement,
    column: HTMLElement,
    target: string | null,
    current: () => boolean,
  ): Promise<void> => {
    // An item's own top spacing keeps the message under the top fade.
    const place = (behavior: ScrollBehavior): void => {
      if (target) scrollToMessage(target, { align: 'start', behavior })
      else scrollToStart({ behavior })
    }
    const off = (): boolean => {
      if (!target) return view.scrollTop > 1
      const element = column.querySelector(`[data-message-id="${CSS.escape(target)}"]`)
      if (!element) return false
      const inset = Number.parseFloat(getComputedStyle(column).paddingTop) || 0
      const top = element.getBoundingClientRect().top - view.getBoundingClientRect().top
      return Math.abs(top - inset) > 1
    }
    let reader = false
    const intent = (): void => {
      reader = true
    }
    const events = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const
    for (const name of events) view.addEventListener(name, intent, { passive: true })
    try {
      place(reducedMotion() ? 'auto' : 'smooth')
      for (let pass = 0; pass < SETTLE_PASSES && off(); pass++) {
        await scrollEnd(view)
        if (reader || !current()) return
        if (off()) place('auto')
      }
    } finally {
      for (const name of events) view.removeEventListener(name, intent)
    }
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
        className="absolute top-1/2 left-1 z-10 flex -translate-y-1/2 flex-col items-start gap-1 focus-ring rounded-md px-2 py-2"
      >
        {Array.from({ length: dashes }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className={cn(
              'h-0.5 rounded-full bg-current',
              i === readingDash ? 'w-4.5 text-secondary' : 'w-3 text-disabled',
            )}
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
        <OutlineItem
          label={t('thread.outline.start')}
          reading={false}
          waiting={waiting === START}
          onJump={() => void jump(null)}
        />
        {rows.map((row, i) => (
          <OutlineItem
            key={row.entryId}
            label={row.label}
            reading={i === readingIndex}
            waiting={waiting === row.entryId}
            onJump={() => void jump(row)}
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
    <DropdownMenuItem closeOnClick={false} onClick={onJump} data-reading={reading || undefined}>
      <span aria-hidden className="flex w-4.5 shrink-0">
        <span
          className={cn(
            'h-0.5 rounded-full bg-current',
            reading ? 'w-4.5 text-secondary' : 'w-3 text-disabled',
          )}
        />
      </span>
      <span className={cn('min-w-0 flex-1 truncate', reading ? 'text-primary' : 'text-secondary')}>
        {label}
      </span>
      {waiting && <Spinner className="size-3.5 shrink-0 text-muted-foreground" />}
    </DropdownMenuItem>
  )
}
