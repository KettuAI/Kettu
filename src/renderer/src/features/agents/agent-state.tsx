import { AlertCircleIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentStatus } from '@shared/agent-host'
import { readiness } from './readiness'
import { Icon } from '@renderer/components/affect/app-shell'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'

/**
 * A short status with its dot or icon: "Sign in to start", "Installing…". Ready asks nothing of
 * the user, so it is the dot alone, named by its tooltip and its accessible name.
 */
export function AgentStateLine({ status, className }: { status: AgentStatus; className?: string }) {
  const { t } = useTranslation('agents')
  const r = readiness(status)
  const base = cn('k-state', className)
  switch (r.kind) {
    case 'ready':
      return (
        <Tooltip>
          <TooltipTrigger
            render={<span role="img" aria-label={t('state.ready')} className={base} />}
          >
            <span className="k-dot" data-tone="ok" />
          </TooltipTrigger>
          <TooltipContent>{t('state.ready')}</TooltipContent>
        </Tooltip>
      )
    case 'sign-in':
      return (
        <span className={base}>
          <span aria-hidden className="k-dot" data-tone="warn" />
          {t('state.signIn')}
        </span>
      )
    case 'installing':
    case 'starting':
      return (
        <span className={base}>
          <span aria-hidden className="ui-ss-spinner" />
          {t(`state.${r.kind}`)}
        </span>
      )
    case 'failed':
      return (
        <span className={base} data-tone="danger">
          <Icon icon={AlertCircleIcon} size={14} />
          {t('state.failed')}
        </span>
      )
    case 'missing':
      return <span className={base}>{t('state.notAvailable')}</span>
  }
}
