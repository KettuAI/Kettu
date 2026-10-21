import { useState } from 'react'
import { CircleAlertIcon, FileDownIcon, RotateCwIcon } from 'lucide-react'
import type { AgentId } from '@shared/thread'
import { exportDiagnostics } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { cn } from '@renderer/lib/utils'
import { agentName, useAgentsStore } from '@renderer/stores/agents'

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
 * "Starting Codex…" with the latest lines the agent printed, such as npx downloading it. With
 * `loading`, a session being opened says "Loading the conversation…" once the agent runs.
 */
export function StartingAgent({
  agentId,
  loading = false,
}: {
  agentId: AgentId
  loading?: boolean
}) {
  const progress = useAgentsStore((s) => s.byId[agentId]?.progress ?? NO_LINES)
  const agentStarting = useAgentsStore((s) => s.byId[agentId]?.state !== 'ready')
  return (
    <div className="flex flex-col items-center gap-2 px-6 pt-6 pb-2 text-center" role="status">
      <span className="inline-flex items-center gap-2 text-[13px] text-muted-foreground">
        <Spinner className="size-3.5" />
        <span className="shimmer">
          {loading && !agentStarting
            ? 'Loading the conversation…'
            : `Starting ${agentName(agentId)}…`}
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
  const [exporting, setExporting] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const save = async () => {
    setExporting(true)
    setNote(null)
    try {
      const path = await exportDiagnostics()
      if (path) setNote(`Saved to ${path}`)
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
          <span className="text-[13px] font-medium">{title}</span>
          <span className="text-[13px] text-muted-foreground" data-selectable="">
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
          Retry
        </Button>
        <Button variant="outline" size="compact" disabled={exporting} onClick={() => void save()}>
          {exporting ? (
            <Spinner data-icon="inline-start" className="size-3" />
          ) : (
            <FileDownIcon data-icon="inline-start" />
          )}
          Export diagnostics
        </Button>
        {note && <span className="min-w-0 truncate text-xs text-muted-foreground">{note}</span>}
      </div>
    </div>
  )
}
