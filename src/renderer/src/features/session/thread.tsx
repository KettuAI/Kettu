import { memo, startTransition, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@renderer/components/ui/message-scroller'
import { cn } from '@renderer/lib/utils'
import { useThreadsStore } from '@renderer/stores/threads'
import {
  AgentEntry,
  CompactionEntry,
  GitEventEntry,
  NoticeEntry,
  PlanEntry,
  SessionMessageEntry,
  ThoughtEntry,
  TurnEndEntry,
  UserEntry,
} from './entries/basic'
import { ReplyFooter } from './entries/message-actions'
import { RunGroup } from './entries/run-group'
import { SubagentCard } from './entries/subagent-card'
import { ToolCard } from './entries/tool-card'
import { ToolGroup } from './entries/tool-group'
import { buildItems, signatureOf } from './thread-items'

// A long history renders from its end: the first frame shows the last items, and older ones
// follow in transitions after it, which MessageScroller keeps in place as they are prepended.
// Each prepend lays the thread out again, so the shown count doubles rather than growing by a
// fixed step: a thread of N items takes log2(N / 40) passes instead of N / 60.
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

export const Thread = memo(function Thread({
  sessionId,
  projectPath,
  agentName,
  working,
}: {
  sessionId: string
  projectPath: string
  agentName: string
  /** A turn is running and the agent has not answered yet. */
  working: boolean
}) {
  const { t } = useTranslation('session')
  const order = useThreadsStore((s) => s.replicas[sessionId]?.state?.order)
  const signature = useThreadsStore((s) => signatureOf(s.replicas[sessionId]?.state))
  const items = useMemo(
    () => buildItems(order ?? [], signature, working),
    [order, signature, working],
  )
  const awaitingReply = working && signature.endsWith('u')
  const shownFrom = useShownFrom(items.length)

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={40}>
      {/* The viewport's bottom fade would mask a focus ring of its own, so the scroller draws it on
          top, inset, for keyboard focus only. */}
      <MessageScroller className="min-h-0 flex-1 scroll-fade-top-overlay after:pointer-events-none after:absolute after:inset-0 after:opacity-0 after:ring-2 after:ring-ring/50 after:ring-inset has-[>[data-slot=message-scroller-viewport]:focus-visible]:after:opacity-100">
        <MessageScrollerViewport
          aria-label={t('thread.label')}
          className="outline-none [scroll-timeline:--scroll-fade-top_y] [scrollbar-gutter:stable_both-edges]"
        >
          <MessageScrollerContent className="mx-auto w-full max-w-[760px] gap-0 px-6 pt-5 pb-8">
            {items.slice(shownFrom).map((item, shownIndex) => {
              const index = shownFrom + shownIndex
              return (
                <MessageScrollerItem
                  key={item.key}
                  messageId={item.key}
                  scrollAnchor={item.type === 'entry' && item.scrollAnchor}
                  className={cn(
                    index > 0 && (item.type === 'entry' && item.turnStart ? 'pt-4' : 'pt-2.5'),
                    // The growing tail would flip between skipped and rendered on every chunk,
                    // recalculating its whole subtree each time.
                    index === items.length - 1 && '[content-visibility:visible]',
                  )}
                >
                  {item.type === 'reply' ? (
                    <ReplyFooter
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
              <MessageScrollerItem messageId="working" className="pt-2.5">
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
      </MessageScroller>
    </MessageScrollerProvider>
  )
})

const Entry = memo(function Entry({
  sessionId,
  entryId,
  projectPath,
  agentName,
}: {
  sessionId: string
  entryId: string
  projectPath: string
  agentName: string
}) {
  const kind = useThreadsStore((s) => s.replicas[sessionId]?.state?.byId[entryId]?.kind)
  const props = { sessionId, entryId }
  switch (kind) {
    case 'user':
      return <UserEntry {...props} />
    case 'agent':
      return <AgentEntry {...props} />
    case 'thought':
      return <ThoughtEntry {...props} />
    case 'tool':
      return <ToolCard {...props} projectPath={projectPath} agentName={agentName} />
    case 'subagent':
      return <SubagentCard {...props} projectPath={projectPath} />
    case 'session_message':
      return <SessionMessageEntry {...props} />
    case 'plan':
      return <PlanEntry {...props} />
    case 'notice':
      return <NoticeEntry {...props} />
    case 'compaction':
      return <CompactionEntry {...props} />
    case 'turn_end':
      return <TurnEndEntry {...props} />
    case 'git':
      return <GitEventEntry {...props} />
    default:
      return null
  }
})
