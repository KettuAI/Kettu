import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { KnownExpiry } from '@shared/prompt-cache'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { CacheRing } from './cache-status'

/**
 * One status per row, by priority: waiting for you, error, running, starting, prompt cache
 * expiring, unread. Its 16 px slot stays when there is none, so a status appearing never moves the
 * title.
 */
export function SessionIndicator({
  summary,
  permissionCount,
  running,
  expiring,
  className,
}: {
  summary: SessionSummary
  permissionCount: number
  running: boolean
  /** The session's prompt cache, in its last minutes. */
  expiring: KnownExpiry | null
  className?: string
}) {
  const { t } = useTranslation('sidebar')

  let mark = null
  if (permissionCount > 0) {
    mark = (
      <span
        role="img"
        aria-label={t('indicator.waiting', { count: permissionCount })}
        className="size-2 rounded-full bg-attention-dot"
      />
    )
  } else if (summary.attention === 'error' || summary.status === 'failed') {
    mark = (
      <CircleAlertIcon
        role="img"
        aria-label={t('indicator.error')}
        className="size-3.5 text-danger"
      />
    )
  } else if (running) {
    mark = <Spinner aria-label={t('indicator.running')} className="size-3 text-info" />
  } else if (summary.status === 'starting') {
    mark = <Spinner aria-label={t('indicator.starting')} className="size-3 text-secondary" />
  } else if (expiring) {
    mark = <CacheRing cache={expiring} />
  } else if (summary.attention === 'unread') {
    mark = (
      <span
        role="img"
        aria-label={t('indicator.unread')}
        className="size-2 rounded-full bg-current text-tertiary"
      />
    )
  }

  return (
    <span
      className={cn(
        'grid size-4 shrink-0 place-items-center transition-opacity duration-(--duration-fast)',
        className,
      )}
    >
      {mark}
    </span>
  )
}
