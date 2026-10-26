import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MessageScroller,
  MessageScrollerButton,
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
import { AgentEntry } from './entries/basic'
import { Entry } from './entries/entry'
import { ReplyFooter } from './entries/message-actions'
import { RunGroup } from './entries/run-group'
import { ToolGroup } from './entries/tool-group'
import { MessageOutline } from './outline/message-outline'
import { hoverReply } from './reply-hover'
import {
  buildItems,
  estimateOf,
  lastSent,
  replyKeys,
  signatureOf,
  type Estimate,
  type Item,
} from './thread-items'
import { TurnStatus } from './turn-status'

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
  /** Resolves once the item `key`, or the first item for null, is rendered. */
  reveal(key: string | null): Promise<void>
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
  19: '[contain-intrinsic-size:auto_19px]',
  20: '[contain-intrinsic-size:auto_20px]',
  22: '[contain-intrinsic-size:auto_22px]',
  24: '[contain-intrinsic-size:auto_24px]',
  28: '[contain-intrinsic-size:auto_28px]',
  71: '[contain-intrinsic-size:auto_71px]',
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

/**
 * 32 px between turns and 16 px under your message; within a reply, 4 px between steps, 12 px
 * beside a step and 16 px between anything else.
 */
function spacing(item: Item, previous: Item, steps: Set<string>): string {
  if (item.type === 'entry' && item.turnStart) return 'pt-8'
  if (item.type === 'reply') return 'pt-2.5'
  if (previous.type === 'entry' && previous.turnStart) return 'pt-4'
  const step = isStep(item, steps)
  if (step && isStep(previous, steps)) return 'pt-1'
  if (step || isStep(previous, steps)) return 'pt-3'
  return 'pt-4'
}

export const Thread = memo(function Thread({
  sessionId,
  projectPath,
  agentName,
  working,
  progressNotes,
  onGutter,
}: {
  sessionId: string
  projectPath: string
  agentName: string
  /** A turn is running. */
  working: boolean
  /** The agent's messages that more work follows show as muted notes between runs. */
  progressNotes: boolean
  /** Told the width the viewport's scrollbar takes, so the composer can leave the same. */
  onGutter: (width: number) => void
}) {
  const { t } = useTranslation('session')
  const order = useThreadsStore((s) => s.replicas[sessionId]?.state?.order)
  const signature = useThreadsStore((s) => signatureOf(s.replicas[sessionId]?.state))
  const items = useMemo(
    () => buildItems(order ?? [], signature, working, progressNotes),
    [order, signature, working, progressNotes],
  )
  const steps = useMemo(() => stepIds(order ?? [], signature), [order, signature])
  const replies = useMemo(() => replyKeys(items), [items])
  // Another session's footer may share a key, so a switch made from the keyboard starts clear.
  useEffect(() => () => hoverReply(null), [sessionId])
  const sent = lastSent(order ?? [], signature)
  const [held, setHeld] = useState(false)
  const shownFrom = useShownFrom(items.length, held)
  const revealing = useRef<{ key: string | null; resolve: () => void } | null>(null)
  const [, setRevealTick] = useState(0)
  useEffect(() => {
    const waiting = revealing.current
    if (!waiting) return
    const index = waiting.key === null ? 0 : items.findIndex((item) => item.key === waiting.key)
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
  // Where scrollbars take room (Windows, and macOS set to show them), the column centres in what
  // the gutter leaves; this reports the gutter whenever the viewport changes size. The first
  // report is made here, in the commit, so the thread's first frame already has it.
  const viewportRef = useCallback(
    (el: HTMLDivElement | null) => {
      viewport.current = el
      if (!el) return
      const report = () => onGutter(el.offsetWidth - el.clientWidth)
      report()
      const observer = new ResizeObserver(report)
      observer.observe(el)
      return () => {
        observer.disconnect()
        viewport.current = null
        onGutter(0)
      }
    },
    [onGutter],
  )

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={40}>
      <ScrollOnSend sent={sent} />
      <MessageScroller className="min-h-0 flex-1 scroll-fade-top-overlay">
        <MessageScrollerViewport
          ref={viewportRef}
          onScroll={nearStart}
          aria-label={t('thread.label')}
          className="outline-none [scroll-timeline:--scroll-fade-top_y]"
        >
          <MessageScrollerContent
            ref={content}
            className="mx-auto w-full max-w-thread gap-0 px-6 pt-5 pb-8"
            onPointerLeave={() => hoverReply(null)}
          >
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
                    // recalculating its whole subtree each time.
                    index === items.length - 1 && '[content-visibility:visible]',
                  )}
                >
                  {item.type === 'reply' ? (
                    <ReplyFooter
                      replyKey={item.key}
                      sessionId={sessionId}
                      agentIds={item.agentIds}
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
                    />
                  ) : item.type === 'group' ? (
                    <ToolGroup
                      sessionId={sessionId}
                      entryIds={item.ids}
                      projectPath={projectPath}
                      agentName={agentName}
                    />
                  ) : item.note ? (
                    <AgentEntry sessionId={sessionId} entryId={item.id} note />
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
            {working && (
              <MessageScrollerItem messageId="turn-status" className="pt-4">
                <TurnStatus sessionId={sessionId} />
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton
          variant="outline"
          size="icon-sm"
          className="rounded-full shadow-md"
        />
        <OlderLoading sessionId={sessionId} />
        <MessageOutline sessionId={sessionId} viewport={viewport} content={content} jumps={jumps} />
      </MessageScroller>
    </MessageScrollerProvider>
  )
})
