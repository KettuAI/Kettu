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
import { Entry } from './entries/entry'
import { ReplyFooter } from './entries/message-actions'
import { RunGroup } from './entries/run-group'
import { ToolGroup } from './entries/tool-group'
import { hoverReply } from './reply-hover'
import { buildItems, lastSent, replyKeys, signatureOf, type Item } from './thread-items'

// A thread opens on its latest page, and older pages load as it scrolls back toward them, a
// viewport ahead. Loaded items render from the end: the first frame shows the last items, and
// older ones follow in transitions after it, which MessageScroller keeps in place as they are
// prepended. Each prepend lays the thread out again, so the shown count doubles rather than
// growing by a fixed step: N items take log2(N / 40) passes instead of N / 60.
const FIRST_ITEMS = 40

function useShownFrom(total: number): number {
  const [limit, setLimit] = useState(FIRST_ITEMS)
  useEffect(() => {
    if (limit >= total) return
    const frame = requestAnimationFrame(() => startTransition(() => setLimit((l) => l * 2)))
    return () => cancelAnimationFrame(frame)
  }, [limit, total])
  return Math.max(0, total - limit)
}

/** The thoughts and tool calls of a thread, whose rows sit close together. */
function stepIds(order: string[], signature: string): Set<string> {
  const ids = new Set<string>()
  order.forEach((id, i) => {
    if ('hgt'.includes(signature[i] ?? '-')) ids.add(id)
  })
  return ids
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
}: {
  sessionId: string
  projectPath: string
  agentName: string
  /** A turn is running and the agent has not answered yet. */
  working: boolean
  /** The agent's messages that more work follows are progress notes, folded with the work. */
  progressNotes: boolean
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
  const awaitingReply = working && signature.endsWith('u')
  const sent = lastSent(order ?? [], signature)
  const shownFrom = useShownFrom(items.length)
  const hasOlder = useThreadsStore((s) => (s.replicas[sessionId]?.older ?? null) !== null)
  const viewport = useRef<HTMLDivElement>(null)
  const nearStart = useCallback(() => {
    const el = viewport.current
    if (el && hasOlder && shownFrom === 0 && el.scrollTop < el.clientHeight) loadOlder(sessionId)
  }, [sessionId, hasOlder, shownFrom])
  // Also after each prepend, and for a page too short to scroll.
  useEffect(nearStart, [nearStart, items.length])

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={40}>
      <ScrollOnSend sent={sent} />
      {/* The viewport's bottom fade would mask a focus ring of its own, so the scroller draws it on
          top, inset, for keyboard focus only. */}
      <MessageScroller className="min-h-0 flex-1 scroll-fade-top-overlay after:pointer-events-none after:absolute after:inset-0 after:opacity-0 after:ring-2 after:ring-ring/50 after:ring-inset has-[>[data-slot=message-scroller-viewport]:focus-visible]:after:opacity-100">
        <MessageScrollerViewport
          ref={viewport}
          onScroll={nearStart}
          aria-label={t('thread.label')}
          className="outline-none [scroll-timeline:--scroll-fade-top_y] [scrollbar-gutter:stable_both-edges]"
        >
          <MessageScrollerContent
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
            {awaitingReply && (
              <MessageScrollerItem messageId="working" className="pt-4">
                <p className="animate-in text-prose text-muted-foreground animation-duration-(--duration-base) fade-in">
                  <span className="shimmer">{t('thread.working')}</span>
                </p>
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
      </MessageScroller>
    </MessageScrollerProvider>
  )
})
