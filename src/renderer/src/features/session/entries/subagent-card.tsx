import { memo } from 'react'
import { BotIcon, ChevronRightIcon, CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('session')
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
        'group/subagent flex w-full flex-col overflow-hidden rounded-xl bg-card text-left text-ui text-card-foreground shadow-card outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring',
        waiting && 'shadow-attention',
        animation,
      )}
    >
      {/* One line is as tall as a tool card's header; the icon and status center on that line. */}
      <span className="flex w-full items-start gap-2 px-3 py-[calc((var(--card-header)-1lh)/2)]">
        <span className="flex h-lh shrink-0 items-center">
          <BotIcon className="size-3.5 text-icon" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-medium">
              {child ? sessionTitle(child) : t('subagent.fallbackTitle')}
            </span>
            {child?.description && (
              <span className="min-w-0 truncate text-muted-foreground">{child.description}</span>
            )}
          </span>
          {running && step && (
            <span
              key={latest?.id}
              className="flex min-w-0 animate-in items-center gap-1.5 text-xs text-muted-foreground animation-duration-(--duration-base) fade-in slide-in-from-bottom-1"
            >
              {step.verb && <span className="shrink-0">{step.verb}</span>}
              <span className={cn('truncate', step.kind !== 'title' && 'font-mono text-meta')}>
                {step.target}
              </span>
            </span>
          )}
        </span>
        <span className="flex h-lh shrink-0 items-center gap-1.5 text-muted-foreground">
          {waiting ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-attention">
              <span aria-hidden className="size-1.5 rounded-full bg-attention-dot" />
              {t('status.needsApproval')}
            </span>
          ) : failed ? (
            <span className="inline-flex items-center gap-1 text-xs text-danger">
              <CircleAlertIcon className="size-3.5" />
              {t('status.failed')}
            </span>
          ) : running ? (
            <Spinner aria-label={t('status.running')} className="size-3.5 text-info" />
          ) : child ? (
            <span className="text-xs">{t('status.done')}</span>
          ) : null}
          <ChevronRightIcon className="size-3.5 opacity-0 transition-opacity duration-(--duration-fast) group-hover/subagent:opacity-100" />
        </span>
      </span>
    </button>
  )
})
