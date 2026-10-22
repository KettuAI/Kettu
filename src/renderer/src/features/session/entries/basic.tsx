import { memo, useState } from 'react'
import {
  ArrowUpIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitPullRequestArrowIcon,
  InfoIcon,
  LayersIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { PlanItem } from '@shared/thread'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Bubble, BubbleContent } from '@renderer/components/ui/bubble'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Marker, MarkerContent, MarkerIcon } from '@renderer/components/ui/marker'
import { Message } from '@renderer/components/ui/message'
import { Spinner } from '@renderer/components/ui/spinner'
import { PrChip } from '@renderer/features/git/pr-chip'
import { duration } from '@renderer/lib/format'
import { PANEL, stopReasonText } from './helpers'
import { cn } from '@renderer/lib/utils'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { Markdown } from '../markdown'
import { useEntry, useEntryAnimation } from '../use-thread'
import { UserActions } from './message-actions'
import { UserContentView } from './user-content'

export interface EntryProps {
  sessionId: string
  entryId: string
}

export const UserEntry = memo(function UserEntry({ sessionId, entryId }: EntryProps) {
  const entry = useEntry(sessionId, entryId, 'user')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <div className={cn('group/actions flex flex-col items-end gap-0.5', animation)}>
      <Message align="end">
        <Bubble variant="muted">
          <BubbleContent className="rounded-2xl px-3.5 py-2 text-prose leading-normal">
            <UserContentView content={entry.content} />
          </BubbleContent>
        </Bubble>
      </Message>
      <UserActions content={entry.content} at={entry.at} steered={entry.steered} />
    </div>
  )
})

export const AgentEntry = memo(function AgentEntry({ sessionId, entryId }: EntryProps) {
  const entry = useEntry(sessionId, entryId, 'agent')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <div className={cn('min-w-0', animation)} data-selectable="">
      <Markdown markdown={entry.markdown} streaming={entry.streaming} />
      {entry.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {entry.attachments.map((ref, i) =>
            ref.kind === 'image' ? (
              <img
                key={i}
                alt=""
                src={`data:${ref.mimeType};base64,${ref.data}`}
                className="max-h-72 max-w-full rounded-lg shadow-card"
              />
            ) : null,
          )}
        </div>
      )}
    </div>
  )
})

export const ThoughtEntry = memo(function ThoughtEntry({ sessionId, entryId }: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'thought')
  const animation = useEntryAnimation(sessionId, entryId)
  const [open, setOpen] = useState(false)
  if (!entry) return null
  const label = entry.streaming
    ? t('thought.live')
    : entry.durationMs !== undefined && entry.durationMs >= 1000
      ? t('thought.doneFor', { duration: duration(entry.durationMs) })
      : t('thought.done')
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={animation}>
      <CollapsibleTrigger className="group/thought -mx-1 flex h-6 items-center gap-1 rounded-md px-1 text-ui text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
        <span className={cn(entry.streaming && 'shimmer')}>{label}</span>
        <ChevronRightIcon className="size-3.5 transition-transform duration-(--duration-fast) group-data-panel-open/thought:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className={PANEL}>
        <div className="mt-1 border-l border-border pl-3 text-muted-foreground" data-selectable="">
          <Markdown
            markdown={entry.markdown}
            streaming={entry.streaming}
            className="markdown-muted"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})

/** In a subagent's thread: the parent's instructions, quoted and labelled with its title. */
export const SessionMessageEntry = memo(function SessionMessageEntry({
  sessionId,
  entryId,
}: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'session_message')
  const sender = useSessionsStore((s) => (entry?.senderId ? s.byId[entry.senderId] : undefined))
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <figure className={cn('flex flex-col gap-1.5', animation)}>
      <figcaption className="text-xs text-muted-foreground">
        {sender
          ? t('sessionMessage.from', { title: sessionTitle(sender) })
          : t('sessionMessage.fromParent')}
      </figcaption>
      <blockquote className="border-l-2 border-border-strong pl-3 text-prose">
        <UserContentView content={entry.content} />
      </blockquote>
    </figure>
  )
})

const NOTICE_ICON = { info: InfoIcon, warning: TriangleAlertIcon, error: CircleAlertIcon }

export const NoticeEntry = memo(function NoticeEntry({ sessionId, entryId }: EntryProps) {
  const entry = useEntry(sessionId, entryId, 'notice')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  const Icon = NOTICE_ICON[entry.severity]
  return (
    <Alert
      variant={
        entry.severity === 'error'
          ? 'destructive'
          : entry.severity === 'warning'
            ? 'warning'
            : 'default'
      }
      className={animation}
    >
      <Icon />
      <AlertTitle>{entry.title}</AlertTitle>
      {entry.description && (
        <AlertDescription className="whitespace-pre-wrap" data-selectable="">
          {entry.description}
        </AlertDescription>
      )}
    </Alert>
  )
})

const COMPACTION_KEY = {
  in_progress: 'inProgress',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const

export const CompactionEntry = memo(function CompactionEntry({ sessionId, entryId }: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'compaction')
  const animation = useEntryAnimation(sessionId, entryId)
  const [open, setOpen] = useState(false)
  if (!entry) return null
  const text = t(`compaction.${COMPACTION_KEY[entry.status]}`)
  const icon =
    entry.status === 'in_progress' ? (
      <Spinner className="size-3.5" />
    ) : (
      <LayersIcon className="size-3.5" />
    )
  if (!entry.summary) {
    return (
      <Marker variant="separator" className={cn('text-xs', animation)}>
        <MarkerIcon className="size-3.5">{icon}</MarkerIcon>
        <MarkerContent className={cn(entry.status === 'in_progress' && 'shimmer')}>
          {text}
        </MarkerContent>
      </Marker>
    )
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={animation}>
      <Marker
        variant="separator"
        className="text-xs"
        render={<CollapsibleTrigger className="group/compaction outline-none" />}
      >
        <MarkerIcon className="size-3.5">{icon}</MarkerIcon>
        <MarkerContent className="inline-flex items-center gap-1 group-hover/compaction:text-foreground">
          {text}
          <ChevronRightIcon className="size-3 transition-transform duration-(--duration-fast) group-data-panel-open/compaction:rotate-90" />
        </MarkerContent>
      </Marker>
      <CollapsibleContent className={PANEL}>
        <div
          className="mt-2 rounded-xl bg-card px-3.5 py-2.5 text-muted-foreground shadow-card"
          data-selectable=""
        >
          <Markdown
            markdown={entry.summary}
            streaming={entry.status === 'in_progress'}
            className="markdown-muted"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})

export const TurnEndEntry = memo(function TurnEndEntry({ sessionId, entryId }: EntryProps) {
  useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'turn_end')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <Marker className={cn('text-xs tabular', animation)}>
      <MarkerContent>{stopReasonText(entry.stopReason, entry.durationMs)}</MarkerContent>
    </Marker>
  )
})

export const GitEventEntry = memo(function GitEventEntry({ sessionId, entryId }: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'git')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  const line = 'flex min-h-6 items-center gap-2 text-ui text-muted-foreground'
  switch (entry.event) {
    case 'commit':
      return (
        <div className={cn('flex flex-col', animation)}>
          {entry.commits.map((c) => (
            <div key={c.oid} className={line}>
              <GitCommitHorizontalIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                <Trans
                  t={t}
                  i18nKey="gitEvent.committed"
                  components={{
                    id: <CommitId oid={c.oid} />,
                    subject: <span className="text-foreground">{c.subject}</span>,
                  }}
                />
              </span>
            </div>
          ))}
          {entry.more > 0 && (
            <div className={cn(line, 'pl-[22px]')}>
              {t('gitEvent.moreCommits', { count: entry.more })}
            </div>
          )}
        </div>
      )
    case 'push':
      return (
        <div className={cn(line, animation)}>
          <ArrowUpIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            <Trans
              t={t}
              i18nKey="gitEvent.pushed"
              count={entry.count}
              components={{
                upstream: (
                  <span className="font-mono text-xs text-foreground">{entry.upstream}</span>
                ),
              }}
            />
          </span>
        </div>
      )
    case 'branch':
      return (
        <div className={cn(line, animation)}>
          <GitBranchIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            <Trans
              t={t}
              i18nKey="gitEvent.switchedTo"
              components={{
                branch: <span className="font-mono text-xs text-foreground">{entry.branch}</span>,
              }}
            />
          </span>
        </div>
      )
    case 'pull_request':
      return (
        <div className={cn(line, animation)}>
          <GitPullRequestArrowIcon className="size-3.5 shrink-0" />
          <span>{t('gitEvent.openedPr')}</span>
          <PrChip url={entry.url} />
        </div>
      )
  }
})

function CommitId({ oid }: { oid: string }) {
  const { t } = useTranslation(['session', 'common'])
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={copied ? t('common:actions.copied') : t('gitEvent.copyCommitId')}
      onClick={() => {
        void navigator.clipboard.writeText(oid).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className={cn(
        'rounded-[4px] px-0.5 font-mono text-xs outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
        copied && 'text-success-text',
      )}
    >
      {oid.slice(0, 7)}
    </button>
  )
}

export const PlanEntry = memo(function PlanEntry({ sessionId, entryId }: EntryProps) {
  const entry = useEntry(sessionId, entryId, 'plan')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <div className={cn('rounded-xl bg-card px-3.5 py-2.5 shadow-card', animation)}>
      <PlanList items={entry.items} />
    </div>
  )
})

export function PlanList({ items }: { items: PlanItem[] }) {
  const { t } = useTranslation('session')
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 py-0.5 text-ui leading-5">
          <span className="flex h-5 items-center">
            {item.status === 'completed' ? (
              <CircleCheckIcon
                role="img"
                aria-label={t('status.done')}
                className="size-3.5 text-muted-foreground"
              />
            ) : item.status === 'in_progress' ? (
              <span
                role="img"
                aria-label={t('plan.inProgress')}
                className="flex size-3.5 items-center justify-center"
              >
                <span className="size-2 rounded-full bg-foreground" />
              </span>
            ) : (
              <CircleIcon
                role="img"
                aria-label={t('plan.todo')}
                className="size-3.5 text-muted-foreground/70"
              />
            )}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1',
              item.status === 'completed' &&
                'text-muted-foreground line-through decoration-border-strong',
              item.status === 'in_progress' && 'font-medium',
            )}
          >
            {item.content}
          </span>
        </li>
      ))}
    </ul>
  )
}
