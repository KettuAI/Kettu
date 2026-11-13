import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  useMessageScroller,
  useMessageScrollerScrollable,
  MessageScrollerViewport,
} from '@renderer/components/ui/message-scroller'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { loadOlder, loadThrough, useThreadsStore } from '@renderer/stores/threads'
import { returnedTo } from '@renderer/stores/view'
import { Entry } from './entries/entry'
import { ReplyFooter } from './entries/message-actions'
import { RunGroup } from './entries/run-group'
import { ToolGroup } from './entries/tool-group'
import { JumpToLatest } from './jump-to-latest'
import { MessageOutline } from './outline/message-outline'
import { hoverReply } from './reply-hover'
import { ReplyToSelection } from './reply-selection'
import { SubSessionStart } from './subagent/sub-session-start'
import { itemAtTop, leaveThread, readingPosition, type ReadingPosition } from './reading-position'
import { playEntrance } from './thread-entrance'
import { TurnStatus } from './turn-status'
import {
  buildItems,
  estimateOf,
  lastSent,
  replyKeys,
  signatureOf,
  withoutPlans,
  type Item,
} from './thread-items'

// A thread renders near its viewport, so opening one costs its first screen however long it is.
// It opens on its latest page with its newest items rendered. Whenever less than a viewport of
// rendered items lies above the view, a batch of older ones renders in a transition, which
// MessageScroller keeps in place as they are prepended; once every loaded item is rendered, the
// page before them loads. Rendered items stay, and off-screen ones skip layout and paint.
const FIRST_ITEMS = 24
const MORE_ITEMS = 16

/** The entry an item starts with; a reply's footer and the turn's status start with none. */
function firstEntryOf(item: Item | undefined): string | null {
  if (item?.type === 'entry') return item.id
  if (item?.type === 'run' || item?.type === 'group') return item.ids[0] ?? null
  return null
}

/** The entry that starts the first item at or after `index` that starts with one. */
function entryFrom(items: readonly Item[], index: number): string | null {
  for (let i = Math.max(0, index); i < items.length; i++) {
    const id = firstEntryOf(items[i])
    if (id !== null) return id
  }
  return null
}

/**
 * Where a thread returning to the item at `index` starts rendering: where it did when it was left,
 * so the items above stay rendered and none is prepended as it settles, else at that item.
 */
function returnStart(items: readonly Item[], position: ReadingPosition, index: number): number {
  const left =
    position.from === null ? -1 : items.findIndex((i) => firstEntryOf(i) === position.from)
  if (left >= 0 && left <= index) return left
  for (let i = index; i > 0; i--) if (firstEntryOf(items[i]) !== null) return i
  return 0
}

/** Where the item a thread was read at is now: by its key, else the item holding its entry. */
function itemOf(items: readonly Item[], position: ReadingPosition): number {
  const at = items.findIndex((item) => item.key === position.item)
  const entry = position.entry
  if (at >= 0 || entry === null) return at
  return items.findIndex((item) =>
    item.type === 'entry'
      ? item.id === entry
      : (item.type === 'run' || item.type === 'group') && item.ids.includes(entry),
  )
}

/**
 * The index of the first rendered item. The rendered items start at an entry rather than an
 * index, so items arriving at the end never push older ones out, and a page loaded before them
 * shows only as the view comes near it. The first render starts at `first` at the latest.
 */
function useShownFrom(
  items: readonly Item[],
  order: readonly string[],
  first: number,
): { shownFrom: number; showFrom: (index: number) => void } {
  const positions = useMemo(() => new Map(order.map((id, i) => [id, i])), [order])
  const [from, setFrom] = useState(() =>
    entryFrom(items, Math.min(first, items.length - FIRST_ITEMS)),
  )
  let shownFrom = Math.max(0, items.length - FIRST_ITEMS)
  const start = from === null ? undefined : positions.get(from)
  if (start !== undefined) {
    shownFrom = items.findIndex((item) => {
      const id = firstEntryOf(item)
      return id !== null && positions.get(id)! >= start
    })
    if (shownFrom < 0) shownFrom = items.length
  }
  const showFrom = useCallback((index: number) => setFrom(entryFrom(items, index)), [items])
  return { shownFrom, showFrom }
}

/** The index past the items from `from` that fill a window by their estimates, at most `to`. */
function windowEnd(
  items: readonly Item[],
  from: number,
  to: number,
  byId: Parameters<typeof estimateOf>[1],
): number {
  let end = from
  for (let height = 0; end < to && height < window.innerHeight; end++) {
    height += estimateOf(items[end]!, byId)
  }
  return end
}

/** What a jump in the outline needs of the thread. */
export interface ThreadJumps {
  /** Resolves once the item `key` is rendered. */
  reveal(key: string): Promise<void>
  /**
   * Holds the rendering of older items and the loading of older pages while a jump's scroll
   * settles: either would prepend items and cut the scroll short.
   */
  hold(on: boolean): void
}

/**
 * Brings a message you send into view, even while you read further up; the thread then follows
 * its end. No message is a scroll anchor: MessageScroller pads the end with a spacer so an anchor
 * can sit at the top, and after a short reply that padding stayed as room to scroll into.
 */
function ScrollOnSend({ sent }: { sent: string | null }) {
  const { scrollToEnd } = useMessageScroller()
  const seen = useRef(sent)
  useEffect(() => {
    if (sent === seen.current) return
    seen.current = sent
    if (sent) scrollToEnd({ behavior: 'auto' })
  }, [sent, scrollToEnd])
  return null
}

/** Frames a returning thread may take to settle its item in place as the items near it render. */
const SETTLE_FRAMES = 10

/**
 * Puts a thread reached by Back or Forward where it was read: the item it was read at, at the same
 * height, or without the item, at its end. It starts a frame after the scroller's own first scroll
 * and corrects as the items near the item render at their real height, unseen, since the thread
 * stays hidden until it is done.
 */
function ReturnTo({
  item,
  offset,
  viewport,
  content,
  onDone,
}: {
  item: string | null
  offset: number
  viewport: RefObject<HTMLDivElement | null>
  content: RefObject<HTMLDivElement | null>
  onDone: () => void
}) {
  const { scrollToEnd } = useMessageScroller()
  useEffect(() => {
    const view = viewport.current
    const column = content.current
    if (!view || !column) return
    const element =
      item === null
        ? null
        : column.querySelector<HTMLElement>(`:scope > [data-message-id="${CSS.escape(item)}"]`)
    // Skipped while it lies above the view, a long item would keep its estimated height there.
    element?.style.setProperty('content-visibility', 'visible')
    // Whether the item was off its place, so the thread moved.
    const place = (): boolean => {
      if (!element) {
        if (item === null) scrollToEnd({ behavior: 'auto' })
        return false
      }
      const off = element.getBoundingClientRect().top - view.getBoundingClientRect().top - offset
      if (Math.abs(off) <= 1) return false
      view.scrollTo({ top: view.scrollTop + off, behavior: 'instant' })
      return true
    }
    let frames = 0
    const settle = (): void => {
      if (place() && ++frames < SETTLE_FRAMES) {
        frame = requestAnimationFrame(settle)
        return
      }
      onDone()
    }
    let frame = requestAnimationFrame(settle)
    return () => {
      cancelAnimationFrame(frame)
      element?.style.removeProperty('content-visibility')
    }
  }, [item, offset, viewport, content, scrollToEnd, onDone])
  return null
}

/**
 * Whether text is selected in the thread. MessageScroller follows the end again once it is near
 * it, which would move the selection away while a reply streams, so a selection holds the thread.
 */
function useSelectedText(viewport: RefObject<HTMLElement | null>): boolean {
  const [selected, setSelected] = useState(false)
  useEffect(() => {
    const changed = (): void => {
      const view = viewport.current
      const selection = document.getSelection()
      setSelected(
        !!view && !!selection && !selection.isCollapsed && view.contains(selection.anchorNode),
      )
    }
    document.addEventListener('selectionchange', changed)
    return () => document.removeEventListener('selectionchange', changed)
  }, [viewport])
  return selected
}

/** Shown at the top while an older page loads there, after a beat so a quick one never flashes. */
function OlderLoading({ sessionId }: { sessionId: string }) {
  const loading = useThreadsStore((s) => s.replicas[sessionId]?.loadingOlder ?? false)
  const { start } = useMessageScrollerScrollable()
  if (!loading || start) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-3 z-10 flex animate-in justify-center animation-duration-(--duration-base) animation-delay-(--duration-base) fade-in [animation-fill-mode:both]"
    >
      <Spinner className="size-4 text-muted-foreground" />
    </div>
  )
}

/** At the top when the page before failed to load: what failed, and Retry. */
function OlderFailed({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation(['session', 'common'])
  const failure = useThreadsStore((s) => {
    const replica = s.replicas[sessionId]
    return replica && !replica.loadingOlder ? (replica.olderFailure?.message ?? null) : null
  })
  if (failure === null) return null
  return (
    <div
      role="alert"
      className="flex animate-in items-center justify-center gap-2 pb-4 text-small text-muted-foreground fade-in animation-duration-(--duration-base)"
    >
      <span className="min-w-0 truncate" title={failure}>
        {t('thread.olderFailed')}
      </span>
      <Button size="xs" variant="outline" onClick={() => void loadOlder(sessionId, true)}>
        {t('common:actions.retry')}
      </Button>
    </div>
  )
}

const isSent = (item: Item): boolean =>
  item.type === 'entry' && (item.char === 'u' || item.char === 's')

const isText = (item: Item): boolean => item.type === 'entry' && item.char === 'a'

/** A folded line of work: a run, a group of lookups or an answered request. */
const isRow = (item: Item): boolean =>
  item.type === 'run' || item.type === 'group' || (item.type === 'entry' && item.char === 'r')

/**
 * The thread's rhythm, as affectUI's chat screen sets it: 22 px between a message you sent and
 * what comes after it, and between turns; 14 px between the parts of a reply, its text, tool calls
 * and cards, but 6 px between a row of work and the text beside it, since the row's own height
 * already pads its one line; 6 px above a reply's actions. The running turn's status sets its own
 * room, so it can take none while the reply's own label carries the turn.
 */
function spacing(item: Item, previous: Item): string {
  if (item.type === 'status') return ''
  if (item.type === 'entry' && item.turnStart) return 'pt-[22px]'
  if (item.type === 'reply') return 'pt-1.5'
  if (isSent(previous) || (item.type === 'entry' && item.char === 's')) return 'pt-[22px]'
  if ((isRow(item) && isText(previous)) || (isText(item) && isRow(previous))) return 'pt-1.5'
  return 'pt-3.5'
}

export const Thread = memo(function Thread({
  sessionId,
  projectPath,
  agentName,
  working,
}: {
  sessionId: string
  projectPath: string
  agentName: string
  /** A turn is running. */
  working: boolean
}) {
  const { t } = useTranslation('session')
  const allOrder = useThreadsStore((s) => s.replicas[sessionId]?.state?.order)
  const allSignature = useThreadsStore((s) => signatureOf(s.replicas[sessionId]?.state))
  const { order, signature } = useMemo(
    () => withoutPlans(allOrder ?? [], allSignature),
    [allOrder, allSignature],
  )
  const items = useMemo(() => buildItems(order, signature, working), [order, signature, working])
  const statusLast = useMemo(() => items.at(-1)?.type === 'status', [items])
  const replies = useMemo(() => replyKeys(items), [items])
  // Another session's footer may share a key, so a switch made from the keyboard starts clear.
  useEffect(() => () => hoverReply(null), [sessionId])
  const sent = lastSent(order, signature)
  const [held, setHeld] = useState(false)
  // Reached by Back or Forward, it returns to where it was read instead of opening at its end.
  const [returning] = useState(() =>
    returnedTo({ kind: 'session', sessionId, projectPath }) ? readingPosition(sessionId) : null,
  )
  const [returnTo, setReturnTo] = useState(returning)
  const returnAt = useMemo(() => (returnTo ? itemOf(items, returnTo) : -1), [items, returnTo])
  const { shownFrom, showFrom } = useShownFrom(
    items,
    order,
    returnTo && returnAt >= 0 ? returnStart(items, returnTo, returnAt) : items.length,
  )
  const revealing = useRef<{ key: string; resolve: () => void } | null>(null)
  const [, setRevealTick] = useState(0)
  // A jump far back renders a window's worth from its target; the items it passes over, from
  // `start` up to `end`, hold their estimated height and render a window's worth at a time in
  // transitions, nearest the target first.
  const [gap, setGap] = useState<{ start: string; end: string } | null>(null)
  const revealFrom = useCallback(
    (index: number) => {
      const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
      const start = windowEnd(items, index, shownFrom, byId)
      setGap(start < shownFrom ? { start: items[start]!.key, end: items[shownFrom]!.key } : null)
      showFrom(index)
    },
    [sessionId, items, shownFrom, showFrom],
  )
  useEffect(() => {
    const waiting = revealing.current
    if (!waiting) return
    const index = items.findIndex((item) => item.key === waiting.key)
    if (index < 0) return
    if (shownFrom > index) {
      revealFrom(index)
      return
    }
    revealing.current = null
    waiting.resolve()
  })
  const gapStart = gap ? items.findIndex((item) => item.key === gap.start) : -1
  const gapEnd = gap ? items.findIndex((item) => item.key === gap.end) : -1
  const gapOpen = gapStart >= 0 && gapStart < gapEnd
  useEffect(() => {
    if (!gap || !gapOpen) return
    const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
    const next = windowEnd(items, gapStart, gapEnd, byId)
    startTransition(() => setGap(next < gapEnd ? { start: items[next]!.key, end: gap.end } : null))
  }, [sessionId, gap, gapOpen, gapStart, gapEnd, items])
  const jumps = useMemo<ThreadJumps>(
    () => ({
      reveal: (key) =>
        new Promise((resolve) => {
          revealing.current = { key, resolve }
          setRevealTick((tick) => tick + 1)
        }),
      hold: setHeld,
    }),
    [],
  )
  const older = useThreadsStore((s) => s.replicas[sessionId]?.older ?? null)
  const hasOlder = older !== null
  // A replica dropped since holds only the latest page: the pages it was read in load first.
  const [pagesLoaded, setPagesLoaded] = useState(false)
  const loadTo = returnTo?.older ?? 0
  const needsPages =
    returnTo !== null && returnAt < 0 && !pagesLoaded && older !== null && older > loadTo
  useEffect(() => {
    if (!needsPages) return
    let live = true
    void loadThrough(sessionId, loadTo).then(() => {
      if (live) setPagesLoaded(true)
    })
    return () => {
      live = false
    }
  }, [needsPages, sessionId, loadTo])
  useEffect(() => {
    if (returnTo && returnAt >= 0 && returnAt < shownFrom) {
      showFrom(returnStart(items, returnTo, returnAt))
    }
  }, [returnTo, returnAt, shownFrom, showFrom, items])
  const returnShown = returnTo !== null && returnAt >= shownFrom
  const returnLost = returnTo !== null && returnAt < 0 && !needsPages
  // Hidden until it shows where it was read, so it never flashes its start, its end or a jump.
  const returnPending = returnTo !== null
  const returned = useCallback(() => setReturnTo(null), [])
  const viewport = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const selected = useSelectedText(viewport)
  const nearStart = useCallback(() => {
    const el = viewport.current
    if (!el || held || returnTo || el.scrollTop >= el.clientHeight) return
    if (shownFrom > 0) startTransition(() => showFrom(shownFrom - MORE_ITEMS))
    else if (hasOlder) loadOlder(sessionId)
  }, [sessionId, held, returnTo, hasOlder, shownFrom, showFrom])
  // Also after each prepend, and for a page too short to scroll.
  useEffect(nearStart, [nearStart, items.length])
  // From the first paint of its items, so the thread never shows before it enters.
  const entrance = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    if (entrance.current || items.length === 0 || returnPending) return
    if (!viewport.current || !content.current) return
    entrance.current = playEntrance(viewport.current, content.current)
  }, [items.length, returnPending])
  // Where it was read when it is left, for Back to return there.
  const latest = useRef({ items, shownFrom, returnPending })
  useLayoutEffect(() => {
    latest.current = { items, shownFrom, returnPending }
  })
  useLayoutEffect(() => {
    const view = viewport.current
    const column = content.current
    return () => {
      if (!view || !column || latest.current.returnPending) return
      const top = itemAtTop(view, column)
      const { items, shownFrom } = latest.current
      const item = top && items.find((each) => each.key === top.item)
      const from = entryFrom(items, shownFrom)
      const older = useThreadsStore.getState().replicas[sessionId]?.older ?? null
      leaveThread(sessionId, top && { ...top, entry: firstEntryOf(item ?? undefined), from, older })
    }
  }, [sessionId])
  // Cleared too, so StrictMode's remount plays it again.
  useEffect(
    () => () => {
      entrance.current?.()
      entrance.current = null
    },
    [],
  )

  // Read, not watched: an estimate matters only until its item first lays out.
  const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId

  return (
    // While it returns it follows no end, which the estimated heights of items not yet laid out
    // would make it seem to reach.
    <MessageScrollerProvider
      autoScroll={!returnPending && !selected}
      defaultScrollPosition={returning ? 'start' : 'end'}
      scrollEdgeThreshold={40}
    >
      <ScrollOnSend sent={sent} />
      <MessageScroller className="ks-thread min-h-0 flex-1 scroll-fade-top-overlay">
        <MessageScrollerViewport
          ref={viewport}
          onScroll={nearStart}
          aria-label={t('thread.label')}
          className={cn(
            'outline-none [scroll-timeline:--scroll-fade-top_y]',
            returnPending && 'invisible',
          )}
        >
          <MessageScrollerContent
            ref={content}
            className="ks-thread__column mx-auto w-full gap-0 px-8 pt-8 pb-4"
            onPointerLeave={() => hoverReply(null)}
          >
            {shownFrom === 0 && !hasOlder && <SubSessionStart sessionId={sessionId} />}
            {shownFrom === 0 && hasOlder && <OlderFailed sessionId={sessionId} />}
            {items.slice(shownFrom).map((item, shownIndex) => {
              const index = shownFrom + shownIndex
              const estimate = estimateOf(item, byId)
              if (gapOpen && index >= gapStart && index < gapEnd) {
                return (
                  <MessageScrollerItem
                    key={item.key}
                    messageId={item.key}
                    style={{ height: estimate, containIntrinsicSize: `auto ${estimate}px` }}
                    className={cn(index > 0 && spacing(item, items[index - 1]!))}
                  />
                )
              }
              return (
                <MessageScrollerItem
                  key={item.key}
                  messageId={item.key}
                  onPointerEnter={() => hoverReply(replies[index] ?? null)}
                  style={{ containIntrinsicSize: `auto ${estimate}px` }}
                  className={cn(
                    // content-visibility's paint containment clips at the item's edge, but fold
                    // lines and tool rows reach 6 px past the column and their focus ring 4 px more.
                    '[overflow-clip-margin:10px]',
                    index > 0 && spacing(item, items[index - 1]!),
                    // A reply's action tooltips float outside its row, which paint containment
                    // would clip; they show only while it is pointed at or focused.
                    item.type === 'reply' &&
                      'hover:[content-visibility:visible] focus-within:[content-visibility:visible]',
                    // The growing tail would flip between skipped and rendered on every chunk,
                    // recalculating its whole subtree each time. With the status last, the entry
                    // before it grows the same way.
                    (index === items.length - 1 || (statusLast && index === items.length - 2)) &&
                      '[content-visibility:visible]',
                  )}
                >
                  {item.type === 'status' ? (
                    <TurnStatus sessionId={sessionId} afterSent={item.afterSent} />
                  ) : item.type === 'reply' ? (
                    <ReplyFooter
                      replyKey={item.key}
                      sessionId={sessionId}
                      projectPath={projectPath}
                      agentIds={item.agentIds}
                      toolIds={item.toolIds}
                      endId={item.endId}
                      latest={item.latest}
                    />
                  ) : item.type === 'run' ? (
                    <RunGroup
                      sessionId={sessionId}
                      entryIds={item.ids}
                      signature={item.signature}
                      projectPath={projectPath}
                      agentName={agentName}
                      latest={statusLast && index === items.length - 2}
                    />
                  ) : item.type === 'group' ? (
                    <ToolGroup
                      sessionId={sessionId}
                      entryIds={item.ids}
                      projectPath={projectPath}
                      agentName={agentName}
                    />
                  ) : (
                    <Entry
                      sessionId={sessionId}
                      entryId={item.id}
                      projectPath={projectPath}
                      agentName={agentName}
                    />
                  )}
                </MessageScrollerItem>
              )
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <ReplyToSelection
          key={sessionId}
          sessionId={sessionId}
          agentName={agentName}
          content={content}
          viewport={viewport}
        />
        <JumpToLatest sessionId={sessionId} working={working} />
        <OlderLoading sessionId={sessionId} />
        <MessageOutline sessionId={sessionId} viewport={viewport} content={content} jumps={jumps} />
      </MessageScroller>
      {returnTo && (returnShown || returnLost) && (
        <ReturnTo
          item={returnShown ? items[returnAt]!.key : null}
          offset={returnTo.offset}
          viewport={viewport}
          content={content}
          onDone={returned}
        />
      )}
    </MessageScrollerProvider>
  )
})
