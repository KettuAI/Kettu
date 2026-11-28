import { memo } from 'react'
import {
  AlertCircleIcon,
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  StopCircleIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Spinner } from '@renderer/components/ui/spinner'
import { HostIcon } from '@renderer/features/settings/remote-parts'
import { clockTime, daysBefore, fullTime, monthDayTime } from '@renderer/lib/format'
import { useClock } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { isAway, useOtherHost } from '@renderer/stores/hosts'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { openRemoteDelegatedSession } from '../cross-host-delegation-tracker'
import { useEntry, useEntryAnimation } from '../use-thread'
import type { EntryProps } from './basic'

const dayStart = (now: number): number => new Date(now).setHours(0, 0, 0, 0)

/**
 * Renders a persisted manual cross-host delegation record in the origin session's thread:
 * - `phase: 'started'`: compact live link showing the target computer, project, agent, title,
 *   and current run state with one-click jump to the target session.
 * - `phase: 'report'`: completion or failure report block showing target host, outcome, optional
 *   reply summary or error, timestamp, and one-click jump to open the remote session.
 */
export const RemoteDelegationEntry = memo(function RemoteDelegationEntry({
  sessionId,
  entryId,
}: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'remote_delegation')
  const animation = useEntryAnimation(sessionId, entryId)
  const targetSession = useSessionsStore((s) => (entry ? s.byId[entry.targetSessionId] : undefined))
  const remoteHost = useOtherHost(entry?.targetHostId ?? null)
  const settledReport = useThreadsStore((s) => {
    if (!entry || entry.phase !== 'started') return null
    const thread = s.replicas[sessionId]?.state
    if (!thread) return null
    for (let i = thread.order.length - 1; i >= 0; i--) {
      const candidate = thread.byId[thread.order[i]!]
      if (
        candidate?.kind === 'remote_delegation' &&
        candidate.phase === 'report' &&
        candidate.delegationId === entry.delegationId
      ) {
        return candidate
      }
    }
    return null
  })
  const today = useClock(dayStart)

  if (!entry) return null

  const title = targetSession ? sessionTitle(targetSession) : entry.targetTitle
  const hostName = remoteHost?.name ?? entry.targetHostName
  const hostPlatform = remoteHost?.platform ?? entry.targetHostPlatform ?? ''
  const hostOffline = entry.targetHostId !== null && isAway(remoteHost?.connection ?? null)
  const canOpen = targetSession !== undefined || entry.targetProjectPath !== null
  const onOpen = () => {
    openRemoteDelegatedSession({
      targetHostId: entry.targetHostId,
      targetSessionId: entry.targetSessionId,
      targetProjectPath: entry.targetProjectPath,
    })
  }

  if (entry.phase === 'started') {
    const reportedOutcome = settledReport?.outcome
    const waiting = !reportedOutcome && targetSession?.attention === 'permission'
    const failed =
      reportedOutcome === 'failed' ||
      targetSession?.attention === 'error' ||
      targetSession?.status === 'failed' ||
      targetSession?.status === 'auth_required'
    const stopped = reportedOutcome === 'stopped'
    const running =
      !reportedOutcome &&
      !failed &&
      (targetSession?.status === 'running' ||
        targetSession?.status === 'awaiting_permission' ||
        targetSession?.status === 'starting' ||
        (!targetSession && !hostOffline))
    const done =
      reportedOutcome === 'completed' ||
      (!reportedOutcome &&
        !failed &&
        !running &&
        (targetSession?.status === 'ready' || targetSession?.status === 'closed'))

    return (
      <button
        type="button"
        disabled={!canOpen}
        onClick={onOpen}
        data-remote-delegation-started={entry.delegationId}
        className={cn(
          'group/started -mx-1.5 inline-flex min-h-6 max-w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-ui outline-none transition-colors duration-(--duration-fast) enabled:hover:bg-hover focus-ring',
          animation,
        )}
      >
        <span className="grid size-3.5 shrink-0 place-items-center">
          <AgentMark agent={entry.targetAgentId} size={14} hostId={entry.targetHostId} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-tertiary">
          <span className="shrink-0">{t('remoteDelegation.delegatedTo', { host: hostName })}</span>
          <span className="inline-flex shrink-0 items-center gap-1 text-secondary">
            <HostIcon platform={hostPlatform} className="size-3" />
          </span>
          {entry.targetProjectName && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {entry.targetProjectName} ·
            </span>
          )}
          <span className="min-w-0 truncate text-primary">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {waiting ? (
            <span className="inline-flex items-center gap-1.5 text-primary">
              <span aria-hidden className="size-1.5 rounded-full bg-attention-dot" />
              {t('status.needsApproval')}
            </span>
          ) : failed ? (
            <span className="inline-flex items-center gap-1 text-danger">
              <HugeiconsIcon
                icon={AlertCircleIcon}
                strokeWidth={1.9}
                aria-hidden
                className="size-3.5"
              />
              {t('status.failed')}
            </span>
          ) : stopped ? (
            <span>{t('remoteDelegation.statusStopped')}</span>
          ) : hostOffline && !done ? (
            <span>{t('remoteDelegation.hostOffline')}</span>
          ) : running ? (
            <Spinner aria-label={t('status.running')} className="size-3.5 text-info" />
          ) : done ? (
            <span>{t('status.done')}</span>
          ) : null}
          {canOpen && (
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              strokeWidth={1.9}
              aria-hidden
              className="size-3 shrink-0 text-muted-foreground"
            />
          )}
        </span>
      </button>
    )
  }

  const outcome = entry.outcome ?? 'completed'
  const isCompleted = outcome === 'completed'
  const isStopped = outcome === 'stopped'
  const headline = isCompleted
    ? t('remoteDelegation.reportFinished', { agent: entry.targetAgentName, host: hostName })
    : isStopped
      ? t('remoteDelegation.reportStopped', { agent: entry.targetAgentName, host: hostName })
      : t('remoteDelegation.reportFailed', { agent: entry.targetAgentName, host: hostName })
  const timeLabel = daysBefore(entry.at, today) === 0 ? clockTime(entry.at) : monthDayTime(entry.at)
  const timeTitle = fullTime(entry.at)
  const timeIso = new Date(entry.at).toISOString()

  return (
    <section
      data-selectable=""
      data-remote-delegation-report={entry.delegationId}
      data-outcome={outcome}
      className={cn(
        'my-1 flex min-w-0 flex-col gap-1.5 rounded-xl bg-(--thread-hover) px-3.5 py-2.5',
        animation,
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui text-muted-foreground">
        <HugeiconsIcon
          icon={isCompleted ? CheckmarkCircle02Icon : isStopped ? StopCircleIcon : AlertCircleIcon}
          strokeWidth={1.9}
          aria-hidden
          className={cn(
            'size-3.5 shrink-0',
            isCompleted && 'text-success',
            !isCompleted && !isStopped && 'text-danger',
          )}
        />
        <span className="shrink-0 font-medium text-foreground">{headline}</span>
        {entry.targetProjectName && (
          <span className="shrink-0 text-xs text-muted-foreground">
            · {entry.targetProjectName}
          </span>
        )}
        {canOpen ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-sm font-medium text-link outline-none hover:underline focus-visible:underline"
            aria-label={t('remoteDelegation.openSession', { title, host: hostName })}
            title={t('remoteDelegation.openSession', { title, host: hostName })}
            onClick={onOpen}
          >
            <span className="truncate">{title}</span>
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              strokeWidth={1.9}
              aria-hidden
              className="size-3 shrink-0"
            />
          </button>
        ) : (
          <span className="min-w-0 truncate font-medium text-foreground">{title}</span>
        )}
        <time
          dateTime={timeIso}
          title={timeTitle}
          className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {timeLabel}
        </time>
      </header>
      {entry.error && (
        <p className="pl-5.5 text-small whitespace-pre-wrap text-danger">{entry.error}</p>
      )}
      {entry.summary && (
        <p className="line-clamp-3 pl-5.5 text-small whitespace-pre-wrap text-secondary">
          {entry.summary}
        </p>
      )}
    </section>
  )
})
