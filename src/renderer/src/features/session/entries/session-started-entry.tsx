import { memo } from 'react'
import { BotIcon, CircleAlertIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import type { EntryProps } from './basic'
import { useEntry, useEntryAnimation } from '../use-thread'

/**
 * A session another session's agent started: its agent's mark, its title and live status; a click
 * opens it.
 */
export const SessionStartedEntry = memo(function SessionStartedEntry({
  sessionId,
  entryId,
}: EntryProps) {
  const { t } = useTranslation('session')
  const entry = useEntry(sessionId, entryId, 'session_started')
  const animation = useEntryAnimation(sessionId, entryId)
  const child = useSessionsStore((s) => (entry ? s.byId[entry.sessionId] : undefined))
  if (!entry) return null

  const running =
    child?.status === 'running' ||
    child?.status === 'awaiting_permission' ||
    child?.status === 'starting'
  const waiting = child?.attention === 'permission'
  const failed = child?.attention === 'error' || child?.status === 'failed'
  const title = child ? sessionTitle(child) : t('sessionStarted.missing')

  return (
    <button
      type="button"
      disabled={!child}
      onClick={() => child && openSession(child.id, child.projectPath)}
      className={cn(
        'group/started -mx-1.5 inline-flex min-h-6 max-w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 text-left text-ui outline-none transition-colors duration-(--duration-fast) enabled:hover:bg-hover focus-ring',
        animation,
      )}
    >
      <span className="grid size-3.5 shrink-0 place-items-center">
        {child ? (
          <AgentMark agent={child.agentId} size={14} />
        ) : (
          <BotIcon className="size-3.5 text-icon" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-tertiary">
        {child ? (
          <Trans
            t={t}
            i18nKey="sessionStarted.label"
            values={{ title }}
            components={{ title: <span className="text-primary" /> }}
          />
        ) : (
          title
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        {waiting ? (
          <span className="inline-flex items-center gap-1.5 text-primary">
            <span aria-hidden className="size-1.5 rounded-full bg-attention-dot" />
            {t('status.needsApproval')}
          </span>
        ) : failed ? (
          <span className="inline-flex items-center gap-1 text-danger">
            <CircleAlertIcon className="size-3.5" />
            {t('status.failed')}
          </span>
        ) : running ? (
          <Spinner aria-label={t('status.running')} className="size-3.5 text-info" />
        ) : child ? (
          <span>{t('status.done')}</span>
        ) : null}
      </span>
    </button>
  )
})
