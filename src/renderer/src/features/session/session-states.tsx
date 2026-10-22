import { useState } from 'react'
import { CircleAlertIcon, FileDownIcon, RotateCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { exportDiagnostics } from '@renderer/app/actions'
import { Bubble, BubbleContent } from '@renderer/components/ui/bubble'
import { Button } from '@renderer/components/ui/button'
import { Message } from '@renderer/components/ui/message'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { agentName, useAgentsStore } from '@renderer/stores/agents'
import { UserContentView } from './entries/user-content'

/** A few entry-shaped placeholders while a thread loads or the agent starts. */
export function ThreadSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('mx-auto flex w-full max-w-[760px] flex-col gap-6 px-6 pt-5', className)}
      aria-hidden
    >
      <Skeleton className="ml-auto h-9 w-2/5 rounded-2xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-3/5" />
      </div>
      <Skeleton className="h-(--card-header) w-full rounded-xl" />
    </div>
  )
}

const NO_LINES: string[] = []

/**
 * "Starting Codex…" with the latest lines the agent printed, or "Installing Codex…" with npm's. With
 * `loading`, a session being opened says "Loading the conversation…" once the agent runs.
 */
export function StartingAgent({
  agentId,
  loading = false,
}: {
  agentId: AgentId
  loading?: boolean
}) {
  const { t } = useTranslation('session')
  const progress = useAgentsStore((s) => s.byId[agentId]?.progress ?? NO_LINES)
  const state = useAgentsStore((s) => s.byId[agentId]?.state)
  const agentStarting = state !== 'ready'
  return (
    <div className="flex flex-col items-center gap-2 px-6 pt-6 pb-2 text-center" role="status">
      <span className="inline-flex items-center gap-2 text-ui text-muted-foreground">
        <Spinner className="size-3.5" />
        <span className="shimmer">
          {loading && !agentStarting
            ? t('agentStart.loading')
            : t(state === 'installing' ? 'agentStart.installing' : 'agentStart.starting', {
                agent: agentName(agentId),
              })}
        </span>
      </span>
      {progress.length > 0 && (
        <div className="flex max-w-[560px] flex-col gap-0.5 font-mono text-[11.5px] text-muted-foreground/80">
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
 * The first message of a session being created, as its thread will show it, with what the session
 * waits for under it, so a send shows at once.
 */
export function FirstMessage({ agentId, text }: { agentId: AgentId; text: string }) {
  const { t } = useTranslation('session')
  const progress = useAgentsStore((s) => s.byId[agentId]?.progress ?? NO_LINES)
  const installing = useAgentsStore((s) => s.byId[agentId]?.state === 'installing')
  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
      <div className="mx-auto flex w-full max-w-[760px] flex-col px-6 pt-5">
        <Message align="end">
          <Bubble variant="muted">
            <BubbleContent className="rounded-2xl px-3.5 py-2 text-prose leading-normal">
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
              className="truncate font-mono text-[11.5px] text-muted-foreground/80 animate-in fade-in animation-duration-(--duration-base)"
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
        <CircleAlertIcon className="mt-px size-4 shrink-0 text-destructive" />
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
