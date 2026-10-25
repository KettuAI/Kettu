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
import { PANEL, stopReasonText } from './helpers'
import { cn } from '@renderer/lib/utils'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { Clamp } from '../clamp'
import { Markdown } from '../markdown'
import { SessionIdContext } from '../media/grants'
import { useEntry, useEntryAnimation } from '../use-thread'
import { CutTurnEnd } from './cut-turn'
import { OutOfCreditEnd } from './out-of-credit'
import { UserActions } from './message-actions'
import { RefChip, SentAttachments, UserContentView } from './user-content'

export interface EntryProps {
  sessionId: string
  entryId: string
}

export const UserEntry = memo(function UserEntry({ sessionId, entryId }: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'user')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  const attachments = entry.content.flatMap((c) =>
    c.type === 'ref' && c.ref.kind === 'attachment' ? [c.ref.attachment] : [],
  )
  const rest = entry.content.filter((c) => c.type !== 'ref' || c.ref.kind !== 'attachment')
  return (
    <div className={cn('group/actions flex flex-col items-end gap-0.5', animation)}>
      {attachments.length > 0 && (
        <div className="flex w-full justify-end pb-1">
          <SentAttachments sessionId={sessionId} attachments={attachments} />
        </div>
      )}
      {/* A message of attachments alone has no bubble. */}
      {rest.length > 0 && (
        <Message align="end">
          <Bubble variant="muted" className="max-w-[85%]">
            <BubbleContent className="rounded-[14px] px-3.5 py-2.5 text-prose leading-normal">
              <UserContentView content={rest} />
            </BubbleContent>
          </Bubble>
        </Message>
      )}
      {/* A prompt another session's agent sent says whose it is, under the bubble. */}
      {entry.from && (
        <span className="pr-0.5 text-xs text-tertiary">
          {t('userEntry.from', { title: entry.from.title })}
        </span>
      )}
      <UserActions content={entry.content} at={entry.at} steered={entry.steered} />
    </div>
  )
})

/** An agent message; `note` sets a progress note between runs, muted like a thought. */
export const AgentEntry = memo(function AgentEntry({
  sessionId,
  entryId,
  note = false,
}: EntryProps & { note?: boolean }) {
  const entry = useEntry(sessionId, entryId, 'agent')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <div className={cn('min-w-0', note && 'text-muted-foreground', animation)} data-selectable="">
      <SessionIdContext value={sessionId}>
        <Markdown
          markdown={entry.markdown}
          streaming={entry.streaming}
          className={note ? 'markdown-muted' : undefined}
        />
      </SessionIdContext>
      {entry.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap items-start gap-1.5">
          {entry.attachments.map((ref, i) =>
            ref.kind === 'image' ? (
              <img
                key={i}
                alt=""
                src={`data:${ref.mimeType};base64,${ref.data}`}
                className="max-h-72 max-w-full rounded-lg shadow-card"
              />
            ) : (
              <RefChip key={i} contentRef={ref} />
            ),
          )}
        </div>
      )}
    </div>
  )
})

export const ThoughtEntry = memo(function ThoughtEntry({ sessionId, entryId }: EntryProps) {
  const entry = useEntry(sessionId, entryId, 'thought')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return (
    <div className={cn('text-muted-foreground', animation)} data-selectable="">
      <SessionIdContext value={sessionId}>
        <Clamp maxHeight={76} buttonClassName="-mx-1.5">
          <Markdown
            markdown={entry.markdown}
            streaming={entry.streaming}
            className="markdown-muted"
          />
        </Clamp>
      </SessionIdContext>
    </div>
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
  if (entry.cause === 'agent_stopped') {
    return (
      <CutTurnEnd
        sessionId={sessionId}
        entryId={entryId}
        title={entry.title}
        className={animation}
      />
    )
  }
  if (entry.cause === 'out_of_credit') {
    return (
      <OutOfCreditEnd title={entry.title} description={entry.description} className={animation} />
    )
  }
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
      <Spinner className="size-3.5 text-info" />
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
        'rounded-[4px] px-0.5 font-mono text-xs outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-primary focus-ring',
        copied && 'text-primary',
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
        <li key={i} className="flex items-start gap-2 py-0.5 text-ui leading-5 text-tertiary">
          <span className="flex h-5 items-center">
            {item.status === 'completed' ? (
              <CircleCheckIcon
                role="img"
                aria-label={t('status.done')}
                className="size-3.5 text-icon"
              />
            ) : item.status === 'in_progress' ? (
              <span
                role="img"
                aria-label={t('plan.inProgress')}
                className="flex size-3.5 items-center justify-center"
              >
                <span className="size-2 rounded-full bg-current text-primary" />
              </span>
            ) : (
              <CircleIcon
                role="img"
                aria-label={t('plan.todo')}
                className="size-3.5 text-disabled"
              />
            )}
          </span>
          <span
            className={cn(
              'min-w-0 flex-1',
              item.status === 'completed' && 'line-through decoration-border-strong',
              item.status === 'in_progress' && 'font-medium text-primary',
            )}
          >
            {item.content}
          </span>
        </li>
      ))}
    </ul>
  )
}
