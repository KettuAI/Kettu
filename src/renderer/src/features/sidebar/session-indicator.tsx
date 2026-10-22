import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { Spinner } from '@renderer/components/ui/spinner'
import { shortAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'

/**
 * One status per row, by priority: waiting for you, error, running, starting, unread.
 * Running and starting rows show no time, since the session is active now.
 */
export function SessionIndicator({
  summary,
  permissionCount,
  running,
}: {
  summary: SessionSummary
  permissionCount: number
  running: boolean
}) {
  const { t } = useTranslation('sidebar')
  const now = useNow()
  if (permissionCount > 0) {
    return (
      <span
        aria-label={t('indicator.waiting', { count: permissionCount })}
        className="grid h-4 min-w-4 place-items-center rounded-full bg-attention px-1 text-[10px] font-semibold text-attention-foreground tabular"
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
        strokeWidth={2}
        className="size-3.5 text-destructive"
      />
    )
  } else if (running) {
    mark = (
      <span
        role="img"
        aria-label={t('indicator.running')}
        className="size-1.5 animate-pulse rounded-full bg-foreground"
      />
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

  const active = running || summary.status === 'starting'
  return (
    <>
      {!active && (
        <span className="text-[11.5px] text-muted-foreground tabular">
          {shortAgo(summary.updatedAt, now)}
        </span>
      )}
      <span className="grid w-4 shrink-0 place-items-center">{mark}</span>
    </>
  )
}
