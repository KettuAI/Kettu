import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { SubSessionStart } from './subagent/sub-session-start'
import { TurnStatus } from './turn-status'
import {
  buildItems,
  estimateOf,
  lastSent,
  replyKeys,
  signatureOf,
  type Estimate,
  type Item,
} from './thread-items'

// A thread opens on its latest page, and older pages load as it scrolls back toward them, a
// viewport ahead. Loaded items render from the end: the first frame shows the last items, and
// older ones follow in transitions after it, which MessageScroller keeps in place as they are
// prepended. Each prepend lays the thread out again, so the shown count doubles rather than
// growing by a fixed step: N items take log2(N / 40) passes instead of N / 60.
const FIRST_ITEMS = 40

function useShownFrom(total: number, held: boolean): number {
  const [limit, setLimit] = useState(FIRST_ITEMS)
  useEffect(() => {
    if (held || limit >= total) return
    const frame = requestAnimationFrame(() => startTransition(() => setLimit((l) => l * 2)))
    return () => cancelAnimationFrame(frame)
  }, [held, limit, total])
  return Math.max(0, total - limit)
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

/** The tool calls of a thread, whose rows sit close together. */
function stepIds(order: string[], signature: string): Set<string> {
  const ids = new Set<string>()
  order.forEach((id, i) => {
    if ('gtw'.includes(signature[i] ?? '-')) ids.add(id)
  })
  return ids
}

// Each estimate as a class of its own, so Tailwind generates it; it replaces the item's default.
const INTRINSIC_SIZE: Record<Estimate, string> = {
  16: '[contain-intrinsic-size:auto_16px]',
  18: '[contain-intrinsic-size:auto_18px]',
  20: '[contain-intrinsic-size:auto_20px]',
  24: '[contain-intrinsic-size:auto_24px]',
  28: '[contain-intrinsic-size:auto_28px]',
  37: '[contain-intrinsic-size:auto_37px]',
  69: '[contain-intrinsic-size:auto_69px]',
}

const isStep = (item: Item, steps: Set<string>): boolean =>
  item.type === 'group' || item.type === 'run' || (item.type === 'entry' && steps.has(item.id))

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

/**
 * 32 px between turns; within one, 4 px between steps, 8 px between a step and the text beside it,
 * 8 px above the reply's actions, 20 px from a message you sent to a paragraph and 16 px between
 * anything else. The running turn's status starts 16 px under a message you sent, where the reply
 * will, and 8 px under the reply's latest entry, the gap of the row that takes its place.
 */
function spacing(item: Item, previous: Item, steps: Set<string>): string {
  if (item.type === 'status') return item.afterSent ? 'pt-4' : 'pt-2'
  if (item.type === 'entry' && item.turnStart) return 'pt-8'
  if (item.type === 'reply') return 'pt-2'
  if (isStep(item, steps) && isStep(previous, steps)) return 'pt-1'
  // A step's row is 28 px tall around one line of text, so it needs less room than a paragraph.
  if ((isStep(item, steps) && isText(previous)) || (isText(item) && isStep(previous, steps))) {
    return 'pt-2'
  }
  if (isSent(previous) && item.type === 'entry' && item.char === 'a') return 'pt-5'
  return 'pt-4'
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
  const order = useThreadsStore((s) => s.replicas[sessionId]?.state?.order)
  const signature = useThreadsStore((s) => signatureOf(s.replicas[sessionId]?.state))
  const items = useMemo(
    () => buildItems(order ?? [], signature, working),
    [order, signature, working],
  )
  const statusLast = useMemo(() => items.at(-1)?.type === 'status', [items])
  const steps = useMemo(() => stepIds(order ?? [], signature), [order, signature])
  const replies = useMemo(() => replyKeys(items), [items])
  // Another session's footer may share a key, so a switch made from the keyboard starts clear.
  useEffect(() => () => hoverReply(null), [sessionId])
  const sent = lastSent(order ?? [], signature)
  const [held, setHeld] = useState(false)
  const shownFrom = useShownFrom(items.length, held)
  const revealing = useRef<{ key: string; resolve: () => void } | null>(null)
  const [, setRevealTick] = useState(0)
  useEffect(() => {
    const waiting = revealing.current
    if (!waiting) return
    const index = items.findIndex((item) => item.key === waiting.key)
    if (index < 0 || shownFrom > index) return
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
    if (el && !held && hasOlder && shownFrom === 0 && el.scrollTop < el.clientHeight) {
      loadOlder(sessionId)
    }
  }, [sessionId, held, hasOlder, shownFrom])
  // Also after each prepend, and for a page too short to scroll.
  useEffect(nearStart, [nearStart, items.length])

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={40}>
      <ScrollOnSend sent={sent} />
      <MessageScroller className="min-h-0 flex-1 scroll-fade-top-overlay">
        <MessageScrollerViewport
          ref={viewport}
          onScroll={nearStart}
          aria-label={t('thread.label')}
          className="outline-none [scroll-timeline:--scroll-fade-top_y]"
        >
          <MessageScrollerContent
            ref={content}
            className="mx-auto w-full max-w-thread gap-0 px-7 pt-7 pb-5"
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
                    index > 0 && spacing(item, items[index - 1]!, steps),
                    // The growing tail would flip between skipped and rendered on every chunk,
                    // recalculating its whole subtree each time. With the status last, the entry
                    // before it grows the same way.
                    (index === items.length - 1 || (statusLast && index === items.length - 2)) &&
                      '[content-visibility:visible]',
                  )}
                >
                  {item.type === 'status' ? (
                    <TurnStatus sessionId={sessionId} />
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
        <JumpToLatest sessionId={sessionId} working={working} />
        <OlderLoading sessionId={sessionId} />
        <MessageOutline sessionId={sessionId} viewport={viewport} content={content} jumps={jumps} />
      </MessageScroller>
    </MessageScrollerProvider>
  )
})
