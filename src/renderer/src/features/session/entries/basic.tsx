import { memo, useState } from 'react'
import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  ArrowUp02Icon,
  Calendar03Icon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  InformationCircleIcon,
  Layers01Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import type { RoutineRef } from '@shared/routines'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { Marker, MarkerContent, MarkerIcon } from '@renderer/components/ui/marker'
import { Spinner } from '@renderer/components/ui/spinner'
import { AIAnswer, type AnswerSource } from '@renderer/components/affect/ai-answer'
import { dayTime } from '@renderer/features/routines/model'
import { PANEL, stopReasonText } from './helpers'
import { cn } from '@renderer/lib/utils'
import { useRoutinesStore } from '@renderer/stores/routines'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { Clamp } from '../clamp'
import { ConfirmedLink } from '../link-confirm'
import { Markdown } from '../markdown'
import { CarriedImage } from '../media/carried-image'
import { CarriedMedia } from '../media/carried-media'
import { EntryIdContext, SessionIdContext } from '../media/grants'
import { TurnDots } from '../turn-dots'
import { writingId } from '../turn-phase'
import { useEntry, useEntryAnimation } from '../use-thread'
import { CutTurnEnd } from './cut-turn'
import { OutOfCreditEnd } from './out-of-credit'
import { splitLinks } from './text-links'
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
  const routine = useSessionsStore((s) => s.byId[sessionId]?.routine ?? null)
  // The prompt of a routine's run is the thread's very first entry, once its first page is here.
  const first = useThreadsStore((s) => {
    const replica = s.replicas[sessionId]
    return !!replica && replica.older === null && replica.state?.order[0] === entryId
  })
  if (!entry) return null
  const attachments = entry.content.flatMap((c) =>
    c.type === 'ref' && c.ref.kind === 'attachment' ? [c.ref.attachment] : [],
  )
  const rest = entry.content.filter((c) => c.type !== 'ref' || c.ref.kind !== 'attachment')
  return (
    <div className={cn('ks-user', animation)}>
      {attachments.length > 0 && (
        <div className="flex w-full justify-end pb-1">
          <SentAttachments sessionId={sessionId} entryId={entryId} attachments={attachments} />
        </div>
      )}
      {/* A message of attachments alone has no bubble. */}
      {rest.length > 0 && (
        <div className="ks-user__bubble">
          <UserContentView content={rest} sessionId={sessionId} entryId={entryId} />
        </div>
      )}
      {/* A prompt another session's agent sent says whose it is, under the bubble. */}
      {entry.from && (
        <span className="ks-user__note">{t('userEntry.from', { title: entry.from.title })}</span>
      )}
      {/* A message from a paired device names it; the host's own windows send unmarked ones. */}
      {entry.device && (
        <span className="ks-user__note">
          {t('userEntry.device', { device: entry.device.name })}
        </span>
      )}
      {first && routine && <RoutineSent routine={routine} />}
      <UserActions content={entry.content} at={entry.at} steered={entry.steered} />
    </div>
  )
})

/** Under a routine's prompt: which routine sent it, and when it was due or that it ran by hand. */
function RoutineSent({ routine }: { routine: RoutineRef }) {
  const { t } = useTranslation('session')
  const name = useRoutinesStore((s) => s.byId[routine.routineId]?.name)
  if (!name) return null
  const when = routine.scheduledFor === null ? null : dayTime(routine.scheduledFor)
  const text =
    routine.trigger === 'manual' || when === null
      ? t('routine.sent', { name })
      : routine.trigger === 'catch-up'
        ? t('routine.catchUp', { name, when })
        : t('routine.due', { name, when })
  return (
    <span className="ks-user__note flex items-center gap-1">
      <HugeiconsIcon
        icon={Calendar03Icon}
        aria-hidden
        strokeWidth={1.9}
        className="size-3 shrink-0"
      />
      <span className="truncate">{text}</span>
    </span>
  )
}

const NO_SOURCES: AnswerSource[] = []

/**
 * An agent message, on affectUI's AI Answer: while it streams, the turn's dots and "Writing" hang
 * under its last line and fold away once it is written.
 */
export const AgentEntry = memo(function AgentEntry({ sessionId, entryId }: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'agent')
  const animation = useEntryAnimation(sessionId, entryId)
  const writing = useThreadsStore((s) => writingId(s.replicas[sessionId]?.state) === entryId)
  // A reply shown already written never shows its label, so only one written while shown has the
  // dots, for the label to fade out when it is done.
  const [wrote, setWrote] = useState(writing)
  if (writing && !wrote) setWrote(true)
  if (!entry) return null
  return (
    <div className={cn('ks-answer min-w-0', animation)} data-selectable="" data-agent-message="">
      <AIAnswer
        sources={NO_SOURCES}
        answer=""
        streaming={writing}
        mark={wrote && <TurnDots phase="writing" />}
        labels={{ writing: t('thread.phase.writing', { count: 1 }) }}
      >
        <SessionIdContext value={sessionId}>
          <EntryIdContext value={entryId}>
            <Markdown markdown={entry.markdown} streaming={entry.streaming} />
          </EntryIdContext>
        </SessionIdContext>
      </AIAnswer>
      {entry.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap items-start gap-1.5">
          {entry.attachments.map((ref, i) =>
            ref.kind === 'image' ? (
              <CarriedImage
                key={i}
                sessionId={sessionId}
                entryId={entryId}
                index={i}
                mimeType={ref.mimeType}
                data={ref.data}
                className="max-h-72 max-w-full rounded-lg shadow-card"
              />
            ) : ref.kind === 'audio' || ref.kind === 'video' ? (
              <CarriedMedia
                key={i}
                sessionId={sessionId}
                entryId={entryId}
                index={i}
                carried={ref}
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
        <EntryIdContext value={entryId}>
          {/* Four of its lines at the default text size. */}
          <Clamp maxHeight={90} buttonClassName="-mx-1.5">
            <Markdown
              markdown={entry.markdown}
              streaming={entry.streaming}
              className="markdown-muted markdown-thought"
            />
          </Clamp>
        </EntryIdContext>
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
    <figure
      className={cn(
        'flex flex-col gap-1 rounded-xl bg-subtle px-3.5 py-2.5 text-ui text-secondary',
        animation,
      )}
    >
      <figcaption className="flex items-center gap-1.5 text-xs font-medium text-tertiary">
        <HugeiconsIcon
          icon={ArrowTurnBackwardIcon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3 shrink-0"
        />
        {sender
          ? t('sessionMessage.from', { title: sessionTitle(sender) })
          : t('sessionMessage.fromParent')}
      </figcaption>
      <blockquote>
        <UserContentView content={entry.content} sessionId={sessionId} entryId={entryId} />
      </blockquote>
    </figure>
  )
})

const NOTICE_ICON = { info: InformationCircleIcon, warning: Alert02Icon, error: AlertCircleIcon }

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
  const glyph = NOTICE_ICON[entry.severity]
  return (
    <Alert
      variant={
        entry.severity === 'error' ? 'error' : entry.severity === 'warning' ? 'warning' : 'default'
      }
      className={cn('ks-notice', animation)}
    >
      <HugeiconsIcon icon={glyph} strokeWidth={1.9} aria-hidden />
      <AlertTitle>{entry.title}</AlertTitle>
      {entry.description && (
        <AlertDescription className="whitespace-pre-wrap" data-selectable="">
          {splitLinks(entry.description).map((part, i) =>
            part.type === 'link' ? <ConfirmedLink key={i} url={part.url} /> : part.text,
          )}
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

/**
 * A compaction divides the thread: rules on both sides of a pill, which opens the summary when
 * there is one.
 */
export const CompactionEntry = memo(function CompactionEntry({ sessionId, entryId }: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'compaction')
  const animation = useEntryAnimation(sessionId, entryId)
  const [open, setOpen] = useState(false)
  if (!entry) return null
  const running = entry.status === 'in_progress'
  const expandable = !running && !!entry.summary
  const label = (
    <>
      <MarkerIcon className="grid size-3.5 place-items-center">
        {running ? (
          <Spinner className="size-3.5 text-info" />
        ) : (
          <HugeiconsIcon icon={Layers01Icon} strokeWidth={1.9} aria-hidden className="size-3.5" />
        )}
      </MarkerIcon>
      <MarkerContent className="ks-compaction-words">
        <span aria-hidden={!running} className={cn(running && 'shimmer')}>
          {t('compaction.inProgress')}
        </span>
        <span aria-hidden={running}>
          {t(`compaction.${COMPACTION_KEY[running ? 'completed' : entry.status]}`)}
        </span>
      </MarkerContent>
    </>
  )
  return (
    <Collapsible open={expandable && open} onOpenChange={setOpen} className={animation}>
      <Marker variant="separator" className="text-xs">
        {/* One element in every state, so the wording swaps in place when the compaction ends. */}
        <CollapsibleTrigger
          disabled={!expandable}
          className="group/compaction inline-flex h-7 flex-none items-center gap-1.5 rounded-full px-2.5 outline-none transition-colors duration-(--duration-fast) disabled:cursor-default enabled:pr-2 enabled:hover:bg-hover enabled:hover:text-foreground enabled:focus-visible:bg-hover enabled:focus-visible:text-foreground"
        >
          {label}
          {expandable && (
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={1.9}
              aria-hidden
              className="size-3 transition-transform duration-(--duration-fast) group-data-panel-open/compaction:rotate-90"
            />
          )}
        </CollapsibleTrigger>
      </Marker>
      <CollapsibleContent className={PANEL}>
        <div
          className="ks-compaction-summary mx-px mt-1.5 mb-px rounded-xl bg-card px-3.5 py-2.5 text-muted-foreground shadow-card"
          data-selectable=""
        >
          <div className="mb-1 text-[10px] leading-4 font-medium tracking-[0.5px] uppercase">
            {t('compaction.summary')}
          </div>
          <Markdown markdown={entry.summary} className="markdown-muted" />
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
              <HugeiconsIcon
                icon={GitCommitIcon}
                strokeWidth={1.9}
                aria-hidden
                className="size-3.5 shrink-0"
              />
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
          <HugeiconsIcon
            icon={ArrowUp02Icon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3.5 shrink-0"
          />
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
          <HugeiconsIcon
            icon={GitBranchIcon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3.5 shrink-0"
          />
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
          <HugeiconsIcon
            icon={GitPullRequestIcon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3.5 shrink-0"
          />
          <span>{t('gitEvent.openedPr')}</span>
          <ConfirmedLink url={entry.url} />
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
        'rounded-sm px-0.5 font-mono text-xs outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-primary focus-ring',
        copied && 'text-primary',
      )}
    >
      {oid.slice(0, 7)}
    </button>
  )
}
