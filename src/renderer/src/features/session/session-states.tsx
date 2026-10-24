import { useState } from 'react'
import { ArrowUpIcon, CircleAlertIcon, FileDownIcon, RotateCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { exportDiagnostics } from '@renderer/app/actions'
import { Bubble, BubbleContent } from '@renderer/components/ui/bubble'
import { Button } from '@renderer/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton } from '@renderer/components/ui/input-group'
import { Message } from '@renderer/components/ui/message'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { agentName, useAgentsStore } from '@renderer/stores/agents'
import { UserContentView } from './entries/user-content'

/**
 * A thread's shape while it loads: a message and a reply at their real sizes and spacing. It fades
 * in late, so a thread that loads at once shows nothing in between.
 */
export function ThreadSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-thread animate-in flex-col px-6 pt-5 fade-in fill-mode-backwards delay-200 animation-duration-(--duration-slow)',
        className,
      )}
      aria-hidden
    >
      <Skeleton className="ml-auto h-[42px] w-2/5 rounded-[14px]" />
      {/* Bars of 10 px on the prose's 26 px lines, and a folded run's shorter line between. */}
      <div className="flex flex-col gap-4 pt-12">
        <Skeleton className="h-2.5 w-11/12" />
        <Skeleton className="h-2.5 w-4/5" />
      </div>
      <Skeleton className="mt-6 h-2.5 w-44 opacity-60" />
      <div className="flex flex-col gap-4 pt-6">
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="h-2.5 w-10/12" />
        <Skeleton className="h-2.5 w-3/5" />
      </div>
    </div>
  )
}

const NO_LINES: string[] = []

/** "Starting Codex…" with the latest lines the agent printed, or "Installing Codex…" with npm's. */
export function StartingAgent({ agentId }: { agentId: AgentId }) {
  const { t } = useTranslation('session')
  const progress = useAgentsStore((s) => s.byId[agentId]?.progress ?? NO_LINES)
  const state = useAgentsStore((s) => s.byId[agentId]?.state)
  return (
    <div className="flex flex-col items-center gap-2 px-6 pt-6 pb-2 text-center" role="status">
      <span className="inline-flex items-center gap-2 text-ui text-muted-foreground">
        <Spinner className={cn('size-3.5', state === 'installing' && 'text-info')} />
        <span className="shimmer">
          {t(state === 'installing' ? 'agentStart.installing' : 'agentStart.starting', {
            agent: agentName(agentId),
          })}
        </span>
      </span>
      {progress.length > 0 && (
        <div className="flex max-w-[560px] flex-col gap-0.5 font-mono text-[11.5px] text-tertiary">
          {progress.slice(-3).map((line, i) => (
            <span
              key={`${i}-${line}`}
              className="truncate animate-in fade-in animation-duration-(--duration-base)"
            >
              {line}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The composer's frame while a session opens, saying what it waits for where the prompt goes:
 * "Starting Codex…", or "Loading the conversation…" once the agent runs, with the agent's latest
 * line under it. The composer takes its place without a shift.
 */
export function ComposerPlaceholder({ agentId }: { agentId: AgentId }) {
  const { t } = useTranslation('session')
  const progress = useAgentsStore((s) => s.byId[agentId]?.progress.at(-1))
  const state = useAgentsStore((s) => s.byId[agentId]?.state)
  const text =
    state === 'ready'
      ? t('agentStart.loading')
      : t(state === 'installing' ? 'agentStart.installing' : 'agentStart.starting', {
          agent: agentName(agentId),
        })
  return (
    <div className="flex flex-col gap-1">
      <InputGroup variant="composer">
        <div
          role="status"
          className="flex min-h-(--composer-min) min-w-0 flex-1 items-center py-[15px] pr-1 pl-4 text-prose leading-[22px] text-muted-foreground"
        >
          <span className="flex min-w-0 animate-in items-center gap-2 fade-in fill-mode-backwards delay-200 animation-duration-(--duration-base)">
            <Spinner className="size-3.5 shrink-0" />
            <span className="truncate shimmer">{text}</span>
          </span>
        </div>
        <InputGroupAddon align="inline-end" className="self-end pr-3 pb-3 pl-1">
          <InputGroupButton size="round" variant="secondary" disabled tabIndex={-1} aria-hidden>
            <ArrowUpIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <div className="flex min-h-row items-center px-2">
        {progress && (
          <span
            key={progress}
            className="truncate font-mono text-[11.5px] text-tertiary animate-in fade-in animation-duration-(--duration-base)"
          >
            {progress}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The first message of a session being created, as its thread will show it, with what the session
 * waits for under it, so a send shows at once.
 */
export function FirstMessage({ agentId, text }: { agentId: AgentId; text: string }) {
  const { t } = useTranslation('session')
  const progress = useAgentsStore((s) => s.byId[agentId]?.progress ?? NO_LINES)
  const installing = useAgentsStore((s) => s.byId[agentId]?.state === 'installing')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
      <div className="mx-auto flex w-full max-w-thread flex-col px-6 pt-5">
        <Message align="end">
          <Bubble variant="muted" className="max-w-[85%]">
            <BubbleContent className="rounded-[14px] px-3.5 py-2.5 text-prose leading-normal">
              <UserContentView content={[{ type: 'text', text }]} />
            </BubbleContent>
          </Bubble>
        </Message>
        <div role="status" className="flex flex-col gap-0.5 pt-2.5">
          <p className="text-prose text-muted-foreground">
            <span className="shimmer">
              {t(installing ? 'agentStart.installing' : 'agentStart.starting', {
                agent: agentName(agentId),
              })}
            </span>
          </p>
          {progress.slice(-3).map((line, i) => (
            <span
              key={`${i}-${line}`}
              className="truncate font-mono text-[11.5px] text-tertiary animate-in fade-in animation-duration-(--duration-base)"
            >
              {line}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The error and its detail, with Retry and Export diagnostics. */
export function FailedState({
  title,
  message,
  detail,
  onRetry,
}: {
  title: string
  message: string
  detail?: string
  onRetry: () => void
}) {
  const { t } = useTranslation(['session', 'common'])
  const [exporting, setExporting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const save = async () => {
    setExporting(true)
    setNote(null)
    try {
      const path = await exportDiagnostics()
      if (path) setNote(t('failed.savedTo', { path }))
    } catch (e) {
      setNote(errorMessage(e))
    } finally {
      setExporting(false)
    }
  }
  return (
    <div
      className="flex animate-in flex-col gap-2.5 rounded-xl bg-card px-3.5 py-3 shadow-card fade-in animation-duration-(--duration-base)"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <CircleAlertIcon className="mt-px size-4 shrink-0 text-danger" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-ui font-medium">{title}</span>
          <span className="text-ui text-muted-foreground" data-selectable="">
            {message}
          </span>
        </div>
      </div>
      {detail && (
        <pre
          data-selectable=""
          className="max-h-40 overflow-auto rounded-lg bg-muted px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
        >
          {detail}
        </pre>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pl-6">
        <Button size="compact" onClick={onRetry}>
          <RotateCwIcon data-icon="inline-start" />
          {t('common:actions.retry')}
        </Button>
        <Button variant="outline" size="compact" disabled={exporting} onClick={() => void save()}>
          {exporting ? (
            <Spinner data-icon="inline-start" className="size-3" />
          ) : (
            <FileDownIcon data-icon="inline-start" />
          )}
          {t('failed.exportDiagnostics')}
        </Button>
        {note && <span className="min-w-0 truncate text-xs text-muted-foreground">{note}</span>}
      </div>
    </div>
  )
}
