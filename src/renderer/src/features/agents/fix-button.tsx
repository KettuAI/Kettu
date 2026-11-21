import { ArrowUpRight01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus } from '@shared/agent-host'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { openHarnessPage, type FixAction } from './problem-fix'

/** A fix's button where a session or New session says the problem. */
export function FixButton({
  action,
  size = 'xs',
  className,
}: {
  action: FixAction
  size?: 'xs' | 'compact'
  className?: string
}) {
  if (action.href) {
    return (
      <a
        href={action.href}
        target="_blank"
        rel="noreferrer"
        className={cn(buttonVariants({ variant: 'outline', size }), 'shrink-0', className)}
      >
        {action.label}
        <HugeiconsIcon
          icon={ArrowUpRight01Icon}
          strokeWidth={1.9}
          aria-hidden
          data-icon="inline-end"
        />
      </a>
    )
  }
  return (
    <Button
      variant="outline"
      size={size}
      className={cn('shrink-0', className)}
      onClick={() => action.run?.()}
    >
      {action.label}
    </Button>
  )
}

/** A session's failure that came from its harness: the harness's page, where it is fixed. */
export function HarnessPageButton({
  status,
  hostId,
}: {
  status: AgentStatus
  hostId: string | null
}) {
  const { t } = useTranslation('settings')
  return (
    <Button size="compact" onClick={() => openHarnessPage(status, hostId)}>
      {t('agents.openHarness', { harness: status.harnessName })}
    </Button>
  )
}
