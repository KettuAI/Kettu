import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
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
import { REVEAL_TTL_MS, useRevealStore } from '@renderer/stores/reveal'
import { useSessionsStore } from '@renderer/stores/sessions'
import { loadOlder, loadThrough, useThreadsStore } from '@renderer/stores/threads'
import { Entry } from './entries/entry'
import { ReplyFooter } from './entries/message-actions'
import { RunGroup } from './entries/run-group'
import { ToolGroup } from './entries/tool-group'
import { FindInSession } from './find/find-in-session'
import { JumpToLatest } from './jump-to-latest'
import { MessageOutline } from './outline/message-outline'
import { RevealTarget } from './outline/reveal-target'
import { hoverReply } from './reply-hover'
import { ReplyMarks } from './reply-marks'
import { ReplyToSelection } from './reply-selection'
import { SubSessionStart } from './subagent/sub-session-start'
import {
  attachReturnAnchor,
  distanceFromEnd,
  itemAtTop,
  leaveThread,
  readingPosition,
  SCROLL_INTENT_KEYS,
  STICK_TO_BOTTOM_THRESHOLD,
  type ReadingPosition,
} from './reading-position'
import { playEntrance } from './thread-entrance'
import { StillRunningLine } from './still-running-line'
import { TurnStatus } from './turn-status'
import {
  buildItems,
  estimateOf,
  lastSent,
  replyKeys,
  signatureOf,
  withoutHidden,
  type Item,
} from './thread-items'
import {
  computeIdleWindow,
  DESKTOP_WINDOW_CONFIG,
  expandWindowForScroll,
  findVisibleIndexRange,
  WEB_WINDOW_CONFIG,
} from './thread-window'

// A thread renders near its viewport, so opening one costs its first screen however long it is.
// It opens on its latest page with its newest items rendered. Whenever less than a viewport of
// rendered items lies above the view, a batch of older ones renders in a transition, which
// MessageScroller keeps in place as they are prepended; once every loaded item is rendered, the
// page before them loads. When a long thread grows past the client's virtualization threshold,
// far off-screen items unmount once scrolling settles (never mid-scroll) while keeping their
// measured height so DOM and heap usage stay bounded without shifting scroll position.
const FIRST_ITEMS = 12
const MORE_ITEMS = 16

const isWebClient = (): boolean =>
  typeof window !== 'undefined' &&
  (window as { kettu?: { client?: string } }).kettu?.client === 'web'

const MAX_STYLE_CACHE = 4096
const estimateStyleCache = new Map<number, CSSProperties>()
const placeholderStyleCache = new Map<number, CSSProperties>()

function estimateStyleFor(height: number): CSSProperties {
  const px = Math.max(1, Math.round(height))
  let style = estimateStyleCache.get(px)
  if (!style) {
    if (estimateStyleCache.size >= MAX_STYLE_CACHE) estimateStyleCache.clear()
    style = { containIntrinsicSize: `auto ${px}px` }
    estimateStyleCache.set(px, style)
  }
  return style
}

function placeholderStyleFor(height: number): CSSProperties {
  const px = Math.max(1, Math.round(height))
  let style = placeholderStyleCache.get(px)
  if (!style) {
    if (placeholderStyleCache.size >= MAX_STYLE_CACHE) placeholderStyleCache.clear()
    style = { height: px, containIntrinsicSize: `auto ${px}px` }
    placeholderStyleCache.set(px, style)
  }
  return style
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sameItem(a: Item, b: Item): boolean {
  if (a === b) return true
  if (a.type !== b.type || a.key !== b.key) return false
  switch (a.type) {
    case 'entry': {
      const o = b as Extract<Item, { type: 'entry' }>
      return (
        a.id === o.id && a.endId === o.endId && a.turnStart === o.turnStart && a.char === o.char
      )
    }
    case 'run': {
      const o = b as Extract<Item, { type: 'run' }>
      return a.signature === o.signature && sameStringArray(a.ids, o.ids)
    }
    case 'group': {
      const o = b as Extract<Item, { type: 'group' }>
      return sameStringArray(a.ids, o.ids)
    }
    case 'reply': {
      const o = b as Extract<Item, { type: 'reply' }>
      return (
        a.endId === o.endId &&
        a.latest === o.latest &&
        a.still === o.still &&
        sameStringArray(a.agentIds, o.agentIds) &&
        sameStringArray(a.toolIds, o.toolIds)
      )
    }
    case 'status': {
      const o = b as Extract<Item, { type: 'status' }>
      return a.afterSent === o.afterSent
    }
    case 'still':
      return true
  }
}

interface ThreadItemProps {
  item: Item
  sessionId: string
  projectPath: string
  agentName: string
  spacingClass: string
  replyKey: string | null
  estimate: number
  gapPlaceholder: boolean
  virtualizedHeight: number | null
  isTail: boolean
  isLatestRun: boolean
}

function sameThreadItem(a: ThreadItemProps, b: ThreadItemProps): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.projectPath === b.projectPath &&
    a.agentName === b.agentName &&
    a.spacingClass === b.spacingClass &&
    a.replyKey === b.replyKey &&
    a.estimate === b.estimate &&
    a.gapPlaceholder === b.gapPlaceholder &&
    a.virtualizedHeight === b.virtualizedHeight &&
    a.isTail === b.isTail &&
    a.isLatestRun === b.isLatestRun &&
    sameItem(a.item, b.item)
  )
}

const ThreadItem = memo(function ThreadItem({
  item,
  sessionId,
  projectPath,
  agentName,
  spacingClass,
  replyKey,
  estimate,
  gapPlaceholder,
  virtualizedHeight,
  isTail,
  isLatestRun,
}: ThreadItemProps) {
  if (gapPlaceholder) {
    return (
      <MessageScrollerItem
        messageId={item.key}
        style={placeholderStyleFor(estimate)}
        className={spacingClass || undefined}
      />
    )
  }
  if (virtualizedHeight !== null) {
    return (
      <MessageScrollerItem
        messageId={item.key}
        style={placeholderStyleFor(virtualizedHeight)}
        className={spacingClass || undefined}
      />
    )
  }
  return (
    <MessageScrollerItem
      messageId={item.key}
      data-reply-key={replyKey ?? undefined}
      style={estimateStyleFor(estimate)}
      className={cn(
        // content-visibility's paint containment clips at the item's edge, but fold
        // lines and tool rows reach 6 px past the column and their focus ring 4 px more.
        '[overflow-clip-margin:10px]',
        // An open Popover marks its enclosing item with `data-popover-open` so menus escape
        // paint containment without per-item `:has(.ui-as-popover)` subtree invalidation.
        'data-[popover-open]:[content-visibility:visible]',
        spacingClass,
        // A reply's action tooltips float outside its row, which paint containment
        // would clip; they show only while it is pointed at or focused.
        item.type === 'reply' &&
          'hover:[content-visibility:visible] focus-within:[content-visibility:visible]',
        // The growing tail would flip between skipped and rendered on every chunk,
        // recalculating its whole subtree each time. With the status last, the entry
        // before it grows the same way.
        isTail && '[content-visibility:visible]',
      )}
    >
      {item.type === 'status' ? (
        <TurnStatus sessionId={sessionId} afterSent={item.afterSent} />
      ) : item.type === 'still' ? (
        <StillRunningLine sessionId={sessionId} />
      ) : item.type === 'reply' ? (
        <ReplyFooter
          replyKey={item.key}
          sessionId={sessionId}
          projectPath={projectPath}
          agentIds={item.agentIds}
          toolIds={item.toolIds}
          endId={item.endId}
          latest={item.latest}
          still={item.still ?? false}
        />
      ) : item.type === 'run' ? (
        <RunGroup
          sessionId={sessionId}
          entryIds={item.ids}
          signature={item.signature}
          projectPath={projectPath}
          agentName={agentName}
          latest={isLatestRun}
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
          endId={item.endId}
          projectPath={projectPath}
          agentName={agentName}
        />
      )}
    </MessageScrollerItem>
  )
}, sameThreadItem)

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
 * Where a thread returning to the item at `index` starts rendering: at most `FIRST_ITEMS` items
 * above `index` (clamped by where it started when left), so there is enough rendered height above
 * the target while it settles without synchronously mounting hundreds of off-screen older items.
 */
function returnStart(items: readonly Item[], position: ReadingPosition, index: number): number {
  const left =
    position.from === null ? -1 : items.findIndex((i) => firstEntryOf(i) === position.from)
  const floor = Math.max(0, index - FIRST_ITEMS)
  if (left >= 0 && left <= index) {
    const start = Math.max(left, floor)
    for (let i = start; i <= index; i++) if (firstEntryOf(items[i]) !== null) return i
  }
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

/** Placeholder gap between the restored viewport window and the pinned tail of a long thread. */
function computeReturnGap(
  items: readonly Item[],
  at: number,
  byId: Parameters<typeof estimateOf>[1],
): { start: string; end: string } | null {
  const tailAnchor = items.length - FIRST_ITEMS
  if (at < 0 || tailAnchor <= at + FIRST_ITEMS) return null
  const start = windowEnd(items, at, tailAnchor, byId)
  return start < tailAnchor ? { start: items[start]!.key, end: items[tailAnchor]!.key } : null
}

function hasPendingReveal(sessionId: string): boolean {
  const target = useRevealStore.getState().target
  return (
    target !== null && target.sessionId === sessionId && Date.now() - target.at <= REVEAL_TTL_MS
  )
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
function ScrollOnSend({ sent, onSend }: { sent: string | null; onSend: () => void }) {
  const { scrollToEnd } = useMessageScroller()
  const seen = useRef(sent)
  useEffect(() => {
    if (sent === seen.current) return
    seen.current = sent
    if (sent) {
      onSend()
      scrollToEnd({ behavior: 'auto' })
    }
  }, [sent, onSend, scrollToEnd])
  return null
}

/**
 * Restores a returning thread to the item it was read at synchronously before the first paint,
 * then holds that item in place against asynchronous height changes or snapshot refreshes until
 * layout quiets down or the reader takes over. Falls back to the end when the item is gone.
 */
function ReturnTo({
  item,
  offset,
  viewport,
  content,
  isSettling,
  onPositioned,
  onFallbackEnd,
  onDone,
}: {
  item: string | null
  offset: number
  viewport: RefObject<HTMLDivElement | null>
  content: RefObject<HTMLDivElement | null>
  isSettling: () => boolean
  onPositioned: () => void
  onFallbackEnd: () => void
  onDone: () => void
}) {
  const { scrollToEnd } = useMessageScroller()
  useLayoutEffect(() => {
    const view = viewport.current
    const column = content.current
    if (!view || !column) return
    return attachReturnAnchor({
      viewport: view,
      content: column,
      itemKey: item,
      offset,
      isSettling,
      onPositioned,
      onFallbackEnd: () => {
        onFallbackEnd()
        scrollToEnd({ behavior: 'auto' })
      },
      onDone,
    })
  }, [
    item,
    offset,
    viewport,
    content,
    isSettling,
    onPositioned,
    onFallbackEnd,
    onDone,
    scrollToEnd,
  ])
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
  if (item.type === 'still') return 'pt-1.5'
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
  commenting,
}: {
  sessionId: string
  projectPath: string
  agentName: string
  /** A turn is running. */
  working: boolean
  /** The session has a composer, which takes comments on passages. */
  commenting: boolean
}) {
  const { t } = useTranslation('session')
  const allOrder = useThreadsStore((s) => s.replicas[sessionId]?.state?.order)
  const allSignature = useThreadsStore((s) => signatureOf(s.replicas[sessionId]?.state))
  const { order, signature } = useMemo(
    () => withoutHidden(allOrder ?? [], allSignature),
    [allOrder, allSignature],
  )
  const still = useSessionsStore((s) => !!s.byId[sessionId]?.stillRunning)
  const items = useMemo(
    () => buildItems(order, signature, working, still),
    [order, signature, working, still],
  )
  const statusLast = useMemo(() => items.at(-1)?.type === 'status', [items])
  const replies = useMemo(() => replyKeys(items), [items])
  // Another session's footer may share a key, so a switch made from the keyboard starts clear.
  useEffect(() => () => hoverReply(null), [sessionId])
  const sent = lastSent(order, signature)
  const [held, setHeld] = useState(false)
  // Reopening a session restores its saved reading position unless Search asked to reveal a message.
  const [returning] = useState(() =>
    hasPendingReveal(sessionId) ? null : readingPosition(sessionId),
  )
  const [returnTo, setReturnTo] = useState(returning)
  const [returnPositioned, setReturnPositioned] = useState(() => returning === null)
  const [followBottom, setFollowBottom] = useState(() => returning === null)
  const detachedRef = useRef(returning !== null)
  const userScrolledRef = useRef(false)
  const returnAt = useMemo(() => (returnTo ? itemOf(items, returnTo) : -1), [items, returnTo])
  const { shownFrom, showFrom } = useShownFrom(
    items,
    order,
    returnTo && returnAt >= 0 ? returnStart(items, returnTo, returnAt) : items.length,
  )
  const revealing = useRef<{ key: string; resolve: () => void } | null>(null)
  const [, setRevealTick] = useState(0)
  // A jump far back (or returning mid-thread) renders a window's worth from its target; the items
  // past that window, from `start` up to `end`, hold their estimated height and render a window's
  // worth at a time in transitions, nearest the target first.
  const [gap, setGap] = useState<{ start: string; end: string } | null>(() => {
    if (!returning) return null
    const at = itemOf(items, returning)
    const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
    return computeReturnGap(items, at, byId)
  })
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
  const gapOpenRef = useRef(false)
  const returnToRef = useRef(returnTo)
  const followBottomRef = useRef(followBottom)
  useLayoutEffect(() => {
    gapOpenRef.current = gapOpen
    returnToRef.current = returnTo
    followBottomRef.current = followBottom
  }, [gapOpen, returnTo, followBottom])
  useEffect(() => {
    if (!gap || !gapOpen || !returnPositioned) return
    const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
    const next = windowEnd(items, gapStart, gapEnd, byId)
    startTransition(() => setGap(next < gapEnd ? { start: items[next]!.key, end: gap.end } : null))
  }, [sessionId, gap, gapOpen, gapStart, gapEnd, items, returnPositioned])
  const [pinnedKey, setPinnedKey] = useState<string | null>(null)
  const jumps = useMemo<ThreadJumps>(
    () => ({
      reveal: (key) =>
        new Promise((resolve) => {
          detachedRef.current = true
          returnToRef.current = null
          setReturnTo(null)
          setReturnPositioned(true)
          setPinnedKey(key)
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
  const prepareReturnWindow = useCallback(
    (position: ReadingPosition, at: number) => {
      const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
      setGap(computeReturnGap(items, at, byId))
      showFrom(returnStart(items, position, at))
    },
    [sessionId, items, showFrom],
  )
  useEffect(() => {
    if (returnTo && returnAt >= 0 && returnAt < shownFrom) {
      startTransition(() => prepareReturnWindow(returnTo, returnAt))
    }
  }, [returnTo, returnAt, shownFrom, prepareReturnWindow])
  const returnShown = returnTo !== null && returnAt >= shownFrom
  const returnLost = returnTo !== null && returnAt < 0 && !needsPages
  const returnPending = returnTo !== null
  const isGapSettling = useCallback(() => gapOpenRef.current, [])
  const markReturnPositioned = useCallback(() => setReturnPositioned(true), [])
  const finishReturn = useCallback(() => {
    returnToRef.current = null
    setReturnTo(null)
  }, [])
  const resumeFollowBottom = useCallback(() => {
    detachedRef.current = false
    userScrolledRef.current = false
    returnToRef.current = null
    followBottomRef.current = true
    setReturnTo(null)
    setReturnPositioned(true)
    setFollowBottom(true)
  }, [])
  const viewport = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const selected = useSelectedText(viewport)
  const windowConfig = isWebClient() ? WEB_WINDOW_CONFIG : DESKTOP_WINDOW_CONFIG
  const keyToIndex = useMemo(() => {
    const map = new Map<string, number>()
    for (let i = shownFrom; i < items.length; i++) map.set(items[i]!.key, i)
    return map
  }, [items, shownFrom])
  // Measured outer height per item key, recorded right before an off-screen item is evicted so
  // placeholders preserve exact scroll height without scanning the whole column during scrolling.
  const measuredHeights = useRef(new Map<string, number>())
  const [windowState, setWindowState] = useState<{
    start: number
    end: number
    heights: ReadonlyMap<string, number>
  } | null>(null)
  const windowStateRef = useRef(windowState)
  useLayoutEffect(() => {
    windowStateRef.current = windowState
  }, [windowState])
  const windowFrame = useRef(0)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleHandle = useRef<number | null>(null)

  const measureBeforeEvict = useCallback(
    (column: HTMLElement, keepStart: number, keepEnd: number) => {
      const tailFrom = items.length - windowConfig.pinTail
      const toMeasure = new Set<string>()
      for (let i = shownFrom; i < tailFrom; i++) {
        if (i >= keepStart && i <= keepEnd) continue
        const key = items[i]!.key
        if (key === pinnedKey) continue
        toMeasure.add(key)
      }
      if (toMeasure.size === 0) return
      for (let child = column.firstElementChild; child; child = child.nextElementSibling) {
        if (!(child instanceof HTMLElement) || child.childElementCount === 0) continue
        const key = child.dataset.messageId
        if (!key || !toMeasure.has(key)) continue
        const height = child.offsetHeight
        if (height > 0) measuredHeights.current.set(key, height)
      }
    },
    [items, shownFrom, pinnedKey, windowConfig.pinTail],
  )

  const evictWindowIdle = useCallback(() => {
    idleTimer.current = null
    idleHandle.current = null
    const renderedCount = items.length - shownFrom
    if (renderedCount <= windowConfig.windowThreshold) {
      if (windowStateRef.current !== null) setWindowState(null)
      return
    }
    if (selected || returnPending || held || gapOpen || revealing.current !== null) return
    const view = viewport.current
    const column = content.current
    if (!view || !column || view.clientHeight <= 0) return

    const visible = findVisibleIndexRange(view, column, keyToIndex, shownFrom, items.length, {
      allowHitTest: true,
    })
    if (!visible) return

    const next = computeIdleWindow(
      windowStateRef.current,
      visible,
      shownFrom,
      items.length,
      windowConfig,
    )
    if (!next) return

    if (next.start <= shownFrom && next.end >= items.length - 1 - windowConfig.pinTail) {
      if (windowStateRef.current !== null) startTransition(() => setWindowState(null))
      return
    }

    measureBeforeEvict(column, next.start, next.end)
    const heights = new Map(measuredHeights.current)
    startTransition(() => setWindowState({ start: next.start, end: next.end, heights }))
  }, [
    items.length,
    shownFrom,
    selected,
    returnPending,
    held,
    gapOpen,
    keyToIndex,
    windowConfig,
    measureBeforeEvict,
  ])

  const scheduleIdleEvict = useCallback(() => {
    if (idleTimer.current !== null) {
      clearTimeout(idleTimer.current)
      idleTimer.current = null
    }
    if (idleHandle.current !== null && typeof cancelIdleCallback === 'function') {
      cancelIdleCallback(idleHandle.current)
      idleHandle.current = null
    }
    if (items.length - shownFrom <= windowConfig.windowThreshold) return
    idleTimer.current = setTimeout(() => {
      idleTimer.current = null
      if (typeof requestIdleCallback === 'function') {
        idleHandle.current = requestIdleCallback(() => evictWindowIdle(), { timeout: 250 })
      } else {
        evictWindowIdle()
      }
    }, windowConfig.idleEvictMs)
  }, [items.length, shownFrom, windowConfig, evictWindowIdle])

  const syncWindowActive = useCallback(() => {
    windowFrame.current = 0
    const renderedCount = items.length - shownFrom
    if (renderedCount <= windowConfig.windowThreshold) {
      if (windowStateRef.current !== null) setWindowState(null)
      return
    }
    if (selected || returnPending || held || gapOpen || revealing.current !== null) return
    const view = viewport.current
    const column = content.current
    if (!view || !column || view.clientHeight <= 0) return

    const prev = windowStateRef.current
    if (prev !== null) {
      const visible = findVisibleIndexRange(view, column, keyToIndex, shownFrom, items.length)
      if (visible) {
        const next = expandWindowForScroll(prev, visible, shownFrom, items.length, windowConfig)
        if (next) {
          // Only measure when the hard safety cap actually trims the far side during a massive scrub.
          if (next.start > prev.start || next.end < prev.end) {
            measureBeforeEvict(column, next.start, next.end)
          }
          const heights = new Map(measuredHeights.current)
          startTransition(() => setWindowState({ start: next.start, end: next.end, heights }))
        }
      }
    }
    scheduleIdleEvict()
  }, [
    items.length,
    shownFrom,
    selected,
    returnPending,
    held,
    gapOpen,
    keyToIndex,
    windowConfig,
    measureBeforeEvict,
    scheduleIdleEvict,
  ])

  const checkNearStart = useCallback(() => {
    const el = viewport.current
    if (!el || held || returnTo || el.scrollTop >= el.clientHeight) return
    if (shownFrom > 0) startTransition(() => showFrom(shownFrom - MORE_ITEMS))
    else if (hasOlder) loadOlder(sessionId)
  }, [sessionId, held, returnTo, hasOlder, shownFrom, showFrom])

  const scheduleScrollSync = useCallback(() => {
    if (windowFrame.current !== 0) return
    windowFrame.current = requestAnimationFrame(() => {
      syncWindowActive()
      checkNearStart()
    })
  }, [syncWindowActive, checkNearStart])

  const markUserScroll = useCallback(() => {
    userScrolledRef.current = true
  }, [])

  const onViewportPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 0 && event.target === event.currentTarget) {
      userScrolledRef.current = true
    }
  }, [])

  const onViewportKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (SCROLL_INTENT_KEYS.has(event.key)) userScrolledRef.current = true
  }, [])

  const onViewportScroll = useCallback(() => {
    const view = viewport.current
    const column = content.current
    if (view && column) {
      const distance = distanceFromEnd(view, column)
      if (distance !== null) {
        if (distance <= STICK_TO_BOTTOM_THRESHOLD) {
          if (
            !returnToRef.current &&
            !gapOpenRef.current &&
            (followBottomRef.current || userScrolledRef.current)
          ) {
            detachedRef.current = false
            userScrolledRef.current = false
            if (!followBottomRef.current) {
              followBottomRef.current = true
              setFollowBottom(true)
            }
          }
        } else if (userScrolledRef.current) {
          detachedRef.current = true
        }
      }
    }
    scheduleScrollSync()
  }, [scheduleScrollSync])

  useEffect(() => {
    scheduleScrollSync()
  }, [scheduleScrollSync, items.length, shownFrom])

  useEffect(
    () => () => {
      if (windowFrame.current !== 0) {
        cancelAnimationFrame(windowFrame.current)
        windowFrame.current = 0
      }
      if (idleTimer.current !== null) {
        clearTimeout(idleTimer.current)
        idleTimer.current = null
      }
      if (idleHandle.current !== null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(idleHandle.current)
        idleHandle.current = null
      }
    },
    [],
  )
  // From the first paint of its items, so the thread never shows before it enters.
  const entrance = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    if (entrance.current || items.length === 0 || !returnPositioned) return
    if (!viewport.current || !content.current) return
    entrance.current = playEntrance(viewport.current, content.current)
  }, [items.length, returnPositioned])
  // Where it was read when it is left, so returning to the session restores that position.
  const latest = useRef({ items, shownFrom, returnPositioned })
  useLayoutEffect(() => {
    latest.current = { items, shownFrom, returnPositioned }
  })
  useLayoutEffect(() => {
    const view = viewport.current
    const column = content.current
    return () => {
      if (!view || !column || !latest.current.returnPositioned) return
      const top = itemAtTop(view, column, {
        edgeThreshold: STICK_TO_BOTTOM_THRESHOLD,
        detached: detachedRef.current,
      })
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

  const onContentPointerOver = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target
    const item =
      target instanceof Element
        ? target.closest<HTMLElement>('[data-slot="message-scroller-item"]')
        : null
    hoverReply(item?.dataset.replyKey || null)
  }, [])

  const onContentPointerLeave = useCallback(() => hoverReply(null), [])

  // Read, not watched: an estimate matters only until its item first lays out.
  const byId = useThreadsStore.getState().replicas[sessionId]?.state?.byId
  const renderedCount = items.length - shownFrom
  const canVirtualize = windowState !== null && renderedCount > windowConfig.windowThreshold
  const tailCutoff = items.length - windowConfig.pinTail

  return (
    // Restored threads keep autoScroll off until the reader scrolls back to the bottom, jumps to
    // latest, or sends a message, so async layout changes or snapshots never yank them to the end.
    <MessageScrollerProvider
      autoScroll={followBottom && returnPositioned && !returnPending && !selected}
      defaultScrollPosition={returning ? 'start' : 'end'}
      scrollEdgeThreshold={STICK_TO_BOTTOM_THRESHOLD}
    >
      <ScrollOnSend sent={sent} onSend={resumeFollowBottom} />
      <MessageScroller className="ks-thread min-h-0 flex-1 scroll-fade-y-overlay">
        <MessageScrollerViewport
          ref={viewport}
          onScroll={onViewportScroll}
          onWheel={markUserScroll}
          onTouchMove={markUserScroll}
          onPointerDown={onViewportPointerDown}
          onKeyDown={onViewportKeyDown}
          aria-label={t('thread.label')}
          className={cn(
            'outline-none [scroll-timeline:--scroll-fade-y_y]',
            !returnPositioned && 'invisible',
          )}
        >
          <MessageScrollerContent
            ref={content}
            className="ks-thread__column relative mx-auto w-full gap-0 px-8 pt-8 pb-4"
            onPointerOver={onContentPointerOver}
            onPointerLeave={onContentPointerLeave}
          >
            {shownFrom === 0 && !hasOlder && <SubSessionStart sessionId={sessionId} />}
            {shownFrom === 0 && hasOlder && <OlderFailed sessionId={sessionId} />}
            {items.slice(shownFrom).map((item, shownIndex) => {
              const index = shownFrom + shownIndex
              const estimate = estimateOf(item, byId)
              const spacingClass = index > 0 ? spacing(item, items[index - 1]!) : ''
              const gapPlaceholder = gapOpen && index >= gapStart && index < gapEnd
              const measured = canVirtualize ? windowState.heights.get(item.key) : undefined
              const virtualizedHeight =
                !gapPlaceholder &&
                canVirtualize &&
                measured !== undefined &&
                index < tailCutoff &&
                item.key !== pinnedKey &&
                (index < windowState.start || index > windowState.end)
                  ? measured
                  : null
              const isTail =
                index === items.length - 1 || (statusLast && index === items.length - 2)
              const isLatestRun = statusLast && index === items.length - 2
              return (
                <ThreadItem
                  key={item.key}
                  item={item}
                  sessionId={sessionId}
                  projectPath={projectPath}
                  agentName={agentName}
                  spacingClass={spacingClass}
                  replyKey={replies[index] ?? null}
                  estimate={estimate}
                  gapPlaceholder={gapPlaceholder}
                  virtualizedHeight={virtualizedHeight}
                  isTail={isTail}
                  isLatestRun={isLatestRun}
                />
              )
            })}
            <ReplyMarks sessionId={sessionId} viewport={viewport} content={content} jumps={jumps} />
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <ReplyToSelection
          key={`reply-${sessionId}`}
          sessionId={sessionId}
          agentName={agentName}
          content={content}
          viewport={viewport}
          commenting={commenting}
        />
        <JumpToLatest sessionId={sessionId} working={working} onJump={resumeFollowBottom} />
        <OlderLoading sessionId={sessionId} />
        <MessageOutline sessionId={sessionId} viewport={viewport} content={content} jumps={jumps} />
        <RevealTarget sessionId={sessionId} viewport={viewport} content={content} jumps={jumps} />
        <FindInSession
          key={`find-${sessionId}`}
          sessionId={sessionId}
          viewport={viewport}
          content={content}
          jumps={jumps}
        />
      </MessageScroller>
      {returnTo && (returnShown || returnLost) && (
        <ReturnTo
          item={returnShown ? items[returnAt]!.key : null}
          offset={returnTo.offset}
          viewport={viewport}
          content={content}
          isSettling={isGapSettling}
          onPositioned={markReturnPositioned}
          onFallbackEnd={resumeFollowBottom}
          onDone={finishReturn}
        />
      )}
    </MessageScrollerProvider>
  )
})
