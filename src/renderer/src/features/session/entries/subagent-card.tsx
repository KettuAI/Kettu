import { memo } from 'react'
import { BotIcon, ChevronRightIcon, CircleAlertIcon } from 'lucide-react'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { openSession } from '@renderer/stores/view'
import { useEntry, useEntryAnimation } from '../use-thread'
import { toolLabel } from './helpers'
import type { EntryProps } from './basic'

/** A subagent the agent started: title, purpose, status, and while it runs its latest step. */
export const SubagentCard = memo(function SubagentCard({
  sessionId,
  entryId,
  projectPath,
}: EntryProps & { projectPath: string }) {
  const entry = useEntry(sessionId, entryId, 'subagent')
  const animation = useEntryAnimation(sessionId, entryId)
  const child = useSessionsStore((s) => (entry ? s.byId[entry.sessionId] : undefined))
  // The child's latest tool call, when its thread is loaded; the card never loads it itself.
  const latest = useThreadsStore((s) => {
    if (!entry) return null
    const state = s.replicas[entry.sessionId]?.state
    if (!state) return null
    for (let i = state.order.length - 1; i >= 0; i--) {
      const e = state.byId[state.order[i]!]
      if (e?.kind === 'tool') return e
    }
    return null
  })
  if (!entry) return null

  const running =
    child?.status === 'running' ||
    child?.status === 'awaiting_permission' ||
    child?.status === 'starting'
  const waiting = child?.attention === 'permission'
  const failed = child?.attention === 'error' || child?.status === 'failed'
  const step = latest ? toolLabel(latest, projectPath) : null

  return (
    <button
      type="button"
      disabled={!child}
      onClick={() => child && openSession(child.id, child.projectPath)}
      className={cn(
        'group/subagent flex w-full flex-col overflow-hidden rounded-xl bg-card text-left text-[13px] text-card-foreground shadow-card outline-none transition-colors duration-(--duration-fast) hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50',
        waiting && 'shadow-attention',
        animation,
      )}
    >
      <span className="flex min-h-card-header w-full items-start gap-2 px-3 py-2">
        <BotIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-medium">{child ? sessionTitle(child) : 'Subagent'}</span>
            {child?.description && (
              <span className="min-w-0 truncate text-muted-foreground">{child.description}</span>
            )}
          </span>
          {running && step && (
            <span
              key={latest?.id}
              className="flex min-w-0 animate-in items-center gap-1.5 text-xs text-muted-foreground duration-(--duration-base) fade-in slide-in-from-bottom-1"
            >
              {step.verb && <span className="shrink-0">{step.verb}</span>}
              <span className={cn('truncate', step.kind !== 'title' && 'font-mono text-[11.5px]')}>
                {step.target}
              </span>
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {waiting ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-attention-text">
              <span aria-hidden className="size-1.5 rounded-full bg-attention" />
              Needs approval
            </span>
          ) : failed ? (
            <span className="inline-flex items-center gap-1 text-destructive">
              <CircleAlertIcon className="size-3.5" />
              Failed
            </span>
          ) : running ? (
            <Spinner aria-label="Running" className="size-3.5" />
          ) : child ? (
            <span>Done</span>
          ) : null}
          <ChevronRightIcon className="size-3.5 opacity-0 transition-opacity duration-(--duration-fast) group-hover/subagent:opacity-100" />
        </span>
      </span>
    </button>
  )
})
