import {
  memo,
  useCallback,
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
import { dashCount, dashOf, ReadingTracker } from './rail'
import { useOutline, type OutlineRow } from './use-outline'

// Less room than this between the viewport's edge and the column's text hides the rail.
const ROOM_PX = 40
// A row shows the spinner only for a jump that waits this long for its pages.
const SPINNER_AFTER_MS = 200

const noSubscribe = (): (() => void) => () => {}
const noReading = (): string | null => null

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

/** Where a message's top comes to rest after a jump: under the top fade. */
function jumpMargin(viewport: HTMLElement, content: HTMLElement): number {
  const fade = Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--scroll-fade-size'))
  const inset = Number.parseFloat(getComputedStyle(content).paddingTop)
  return Math.max(0, (fade || 0) - (inset || 0))
}

/**
 * The message outline: a rail of dashes at the thread's left edge, one per user message with the
 * reading position marked, that opens into a list of them to jump between.
 */
export const MessageOutline = memo(function MessageOutline({
  sessionId,
  viewport,
  content,
  revealAll,
}: {
  sessionId: string
  viewport: RefObject<HTMLDivElement | null>
  content: RefObject<HTMLDivElement | null>
  /** Renders every loaded item, resolving once they are in the document. */
  revealAll: () => Promise<void>
}) {
  const { t } = useTranslation('session')
  const { rows, opened } = useOutline(sessionId)
  const { height, room } = useRailBox(viewport, content)
  const { scrollToMessage, scrollToStart } = useMessageScroller()

  const [tracker, setTracker] = useState<ReadingTracker | null>(null)
  useEffect(() => {
    const view = viewport.current
    const column = content.current
    if (!view || !column) return
    const next = new ReadingTracker(view, column)
    setTracker(next)
    return () => {
      next.disconnect()
      setTracker(null)
    }
  }, [viewport, content])
  useEffect(() => {
    tracker?.setMessages(rows.map((row) => row.entryId))
  }, [tracker, rows])
  const reading = useSyncExternalStore(tracker?.subscribe ?? noSubscribe, tracker?.get ?? noReading)
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

  const jump = useCallback(
    async (row: OutlineRow | null) => {
      const view = viewport.current
      const column = content.current
      if (!view || !column) return
      const id = ++jumping.current
      const key = row?.entryId ?? 'start'
      const replica = useThreadsStore.getState().replicas[sessionId]
      const loaded = row
        ? replica?.state?.byId[row.entryId] !== undefined
        : (replica?.older ?? null) === null
      if (!loaded) {
        const timer = setTimeout(() => {
          if (jumping.current === id) setWaiting(key)
        }, SPINNER_AFTER_MS)
        const done = await loadThrough(sessionId, row?.pos ?? 0)
        clearTimeout(timer)
        if (jumping.current !== id) return
        setWaiting(null)
        if (!done) return
      }
      await revealAll()
      if (jumping.current !== id) return
      const behavior = reducedMotion() ? 'auto' : 'smooth'
      if (!row) {
        scrollToStart({ behavior })
        setOpen(false)
        return
      }
      const margin = jumpMargin(view, column)
      scrollToMessage(row.entryId, { align: 'start', behavior, scrollMargin: margin })
      setOpen(false)
      // Items above the target keep an estimated height until they render, so a long smooth
      // scroll can land off; it is set right once it ends.
      if (behavior === 'smooth') {
        view.addEventListener(
          'scrollend',
          () => {
            const target = column.querySelector(`[data-message-id="${CSS.escape(row.entryId)}"]`)
            if (!target) return
            const inset = Number.parseFloat(getComputedStyle(column).paddingTop) || 0
            const top = target.getBoundingClientRect().top - view.getBoundingClientRect().top
            if (Math.abs(top - inset - margin) > 1) {
              scrollToMessage(row.entryId, {
                align: 'start',
                behavior: 'auto',
                scrollMargin: margin,
              })
            }
          },
          { once: true },
        )
      }
    },
    [sessionId, viewport, content, revealAll, scrollToMessage, scrollToStart],
  )

  // The list opens scrolled to the reading position, and a keyboard opening highlights it.
  const popup = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const list = popup.current
      const row = list?.querySelector<HTMLElement>('[data-reading]')
      if (!list || !row) return
      list.scrollTop = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2
      if (list.contains(document.activeElement)) row.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
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
        className="absolute top-1/2 left-1 z-10 flex -translate-y-1/2 flex-col items-start gap-1 rounded-md px-2 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          waiting={waiting === 'start'}
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
