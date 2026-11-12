import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { loadOlder, useThreadsStore } from '@renderer/stores/threads'
import { Entry } from './entries/entry'
import { ReplyFooter } from './entries/message-actions'
import { RunGroup } from './entries/run-group'
import { ToolGroup } from './entries/tool-group'
import { JumpToLatest } from './jump-to-latest'
import { MessageOutline } from './outline/message-outline'
import { hoverReply } from './reply-hover'
import { ReplyToSelection } from './reply-selection'
import { SubSessionStart } from './subagent/sub-session-start'
import { playEntrance } from './thread-entrance'
import { TurnStatus } from './turn-status'
import {
  buildItems,
  estimateOf,
  lastSent,
  replyKeys,
  signatureOf,
  withoutPlans,
  type Estimate,
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
 * The index of the first rendered item. The rendered items start at an entry rather than an
 * index, so items arriving at the end never push older ones out, and a page loaded before them
 * shows only as the view comes near it.
 */
function useShownFrom(
  items: readonly Item[],
  order: readonly string[],
): { shownFrom: number; showFrom: (index: number) => void } {
  const positions = useMemo(() => new Map(order.map((id, i) => [id, i])), [order])
  const [from, setFrom] = useState(() => entryFrom(items, items.length - FIRST_ITEMS))
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

// Each estimate as a class of its own, so Tailwind generates it; it replaces the item's default.
const INTRINSIC_SIZE: Record<Estimate, string> = {
  18: '[contain-intrinsic-size:auto_18px]',
  20: '[contain-intrinsic-size:auto_20px]',
  24: '[contain-intrinsic-size:auto_24px]',
  28: '[contain-intrinsic-size:auto_28px]',
  69: '[contain-intrinsic-size:auto_69px]',
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
  const { shownFrom, showFrom } = useShownFrom(items, order)
  const revealing = useRef<{ key: string; resolve: () => void } | null>(null)
  const [, setRevealTick] = useState(0)
  useEffect(() => {
    const waiting = revealing.current
    if (!waiting) return
    const index = items.findIndex((item) => item.key === waiting.key)
    if (index < 0) return
    if (shownFrom > index) {
      showFrom(index)
      return
    }
    revealing.current = null
    waiting.resolve()
  })
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
  const hasOlder = useThreadsStore((s) => (s.replicas[sessionId]?.older ?? null) !== null)
  const viewport = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const nearStart = useCallback(() => {
    const el = viewport.current
    if (!el || held || el.scrollTop >= el.clientHeight) return
    if (shownFrom > 0) startTransition(() => showFrom(shownFrom - MORE_ITEMS))
    else if (hasOlder) loadOlder(sessionId)
  }, [sessionId, held, hasOlder, shownFrom, showFrom])
  // Also after each prepend, and for a page too short to scroll.
  useEffect(nearStart, [nearStart, items.length])
  // From the first paint of its items, so the thread never shows before it enters.
  const entrance = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    if (entrance.current || items.length === 0 || !viewport.current || !content.current) return
    entrance.current = playEntrance(viewport.current, content.current)
  }, [items.length])
  // Cleared too, so StrictMode's remount plays it again.
  useEffect(
    () => () => {
      entrance.current?.()
      entrance.current = null
    },
    [],
  )

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={40}>
      <ScrollOnSend sent={sent} />
      <MessageScroller className="ks-thread min-h-0 flex-1 scroll-fade-top-overlay">
        <MessageScrollerViewport
          ref={viewport}
          onScroll={nearStart}
          aria-label={t('thread.label')}
          className="outline-none [scroll-timeline:--scroll-fade-top_y]"
        >
          <MessageScrollerContent
            ref={content}
            className="ks-thread__column mx-auto w-full gap-0 px-8 pt-8 pb-4"
            onPointerLeave={() => hoverReply(null)}
          >
            {shownFrom === 0 && !hasOlder && <SubSessionStart sessionId={sessionId} />}
            {items.slice(shownFrom).map((item, shownIndex) => {
              const index = shownFrom + shownIndex
              return (
                <MessageScrollerItem
                  key={item.key}
                  messageId={item.key}
                  onPointerEnter={() => hoverReply(replies[index] ?? null)}
                  className={cn(
                    // content-visibility's paint containment clips at the item's edge, but fold
                    // lines and tool rows reach 6 px past the column and their focus ring 4 px more.
                    '[overflow-clip-margin:10px]',
                    INTRINSIC_SIZE[estimateOf(item)],
                    index > 0 && spacing(item, items[index - 1]!),
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
    </MessageScrollerProvider>
  )
})
