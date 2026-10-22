import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'

/**
 * One status per row, by priority: waiting for you, error, running, starting, unread. Its 16 px
 * slot stays when there is none, so a status appearing never moves the title. The slot is square
 * because the row truncates its last span, which would otherwise clip the running halo.
 */
export function SessionIndicator({
  summary,
  permissionCount,
  running,
  className,
}: {
  summary: SessionSummary
  permissionCount: number
  running: boolean
  className?: string
}) {
  const { t } = useTranslation('sidebar')
  if (permissionCount > 0) {
    return (
      <span
        aria-label={t('indicator.waiting', { count: permissionCount })}
        className={cn(
          'grid h-4 min-w-4 place-items-center rounded-full bg-attention px-1 text-[10px] font-semibold text-attention-foreground tabular transition-opacity duration-(--duration-fast)',
          className,
        )}
      >
        {permissionCount}
      </span>
    )
  }

  let mark = null
  if (summary.attention === 'error' || summary.status === 'failed') {
    mark = (
      <CircleAlertIcon
        role="img"
        aria-label={t('indicator.error')}
        className="size-3.5 text-destructive"
      />
    )
  } else if (running) {
    mark = (
      <span
        role="img"
        aria-label={t('indicator.running')}
        className="relative size-2 rounded-full bg-running"
      >
        <span className="absolute inset-0 animate-ping rounded-full bg-running opacity-75" />
      </span>
    )
  } else if (summary.status === 'starting') {
    mark = <Spinner aria-label={t('indicator.starting')} className="size-3 text-muted-foreground" />
  } else if (summary.attention === 'unread') {
    mark = (
      <span
        role="img"
        aria-label={t('indicator.unread')}
        className="size-1.5 rounded-full bg-muted-foreground"
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
