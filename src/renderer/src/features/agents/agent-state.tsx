import { CircleAlertIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus } from '@shared/agent-host'
import { readiness } from './readiness'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'

/**
 * A short status with its dot or icon: "Sign in to start", "Installing…". Ready asks nothing of
 * the user, so it is the dot alone, named by its tooltip and its accessible name.
 */
export function AgentStateLine({ status, className }: { status: AgentStatus; className?: string }) {
  const { t } = useTranslation('agents')
  const r = readiness(status)
  const base = cn('inline-flex items-center gap-1.5 text-xs', className)
  switch (r.kind) {
    case 'ready':
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <span role="img" aria-label={t('state.ready')} className={cn(base, 'h-4 px-1')} />
            }
          >
            <span className="size-1.5 rounded-full bg-current text-success" />
          </TooltipTrigger>
          <TooltipContent>{t('state.ready')}</TooltipContent>
        </Tooltip>
      )
    case 'sign-in':
      return (
        <span className={cn(base, 'text-secondary')}>
          <span aria-hidden className="size-1.5 rounded-full bg-current text-tertiary" />
          {t('state.signIn')}
        </span>
      )
    case 'installing':
    case 'starting':
      return (
        <span className={cn(base, 'text-tertiary')}>
          <Spinner className={cn('size-3', r.kind === 'installing' && 'text-info')} />
          {t(`state.${r.kind}`)}
        </span>
      )
    case 'failed':
      return (
        <span className={cn(base, 'text-danger')}>
          <CircleAlertIcon className="size-3.5" />
          {t('state.failed')}
        </span>
      )
    case 'missing':
      return <span className={cn(base, 'text-tertiary')}>{t('state.notAvailable')}</span>
  }
}
