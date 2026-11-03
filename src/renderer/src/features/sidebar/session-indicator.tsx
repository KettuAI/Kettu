import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { KnownExpiry } from '@shared/prompt-cache'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { CacheRing } from './cache-status'
import type { RowStatus } from './row-status'

/**
 * One status per row, by priority: waiting for you, error, running, starting, prompt cache
 * expiring, unread. Its 16 px slot stays when there is none, so a status appearing never moves the
 * title.
 */
export function SessionIndicator({
  status,
  expiring,
  className,
}: {
  status: RowStatus
  /** The session's prompt cache, in its last minutes. */
  expiring: KnownExpiry | null
  className?: string
}) {
  const { t } = useTranslation('sidebar')

  let mark = null
  if (status.waiting > 0) {
    mark = (
      <span
        role="img"
        aria-label={t('indicator.waiting', { count: status.waiting })}
        className="size-2 rounded-full bg-attention-dot shadow-[0_0_0_3px_var(--attention-halo)]"
      />
    )
  } else if (status.failed) {
    mark = (
      <CircleAlertIcon
        role="img"
        aria-label={t('indicator.error')}
        className="size-3.5 text-danger"
      />
    )
  } else if (status.running || status.starting) {
    mark = (
      <RingSpinner
        aria-label={t(status.running ? 'indicator.running' : 'indicator.starting')}
        className="size-[11.5px] border-[1.6px]"
      />
    )
  } else if (expiring) {
    mark = <CacheRing cache={expiring} />
  } else if (status.unread) {
    mark = (
      <span
        role="img"
        aria-label={t('indicator.unread')}
        className="size-2 rounded-full bg-(--text-tertiary)"
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
