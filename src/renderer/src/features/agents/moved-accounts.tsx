// Accounts an agent's vendor moved to another harness, such as personal Google accounts from Gemini
// CLI to Antigravity: shown where the agent refused one, with one click to that harness's page.

import { AlertCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

/** A session or a start that failed on such an account: Kettu's message and the way out. */
export function AccountMovedAlert({
  agent,
  to,
  message,
  onOpen,
  onRetry,
  className,
}: {
  agent: string
  /** The harness the accounts went to, by name. */
  to: string
  message: string
  onOpen: () => void
  onRetry?: () => void
  className?: string
}) {
  const { t } = useTranslation(['session', 'common'])
  return (
    <Alert
      variant="warning"
      className={cn(
        onRetry ? 'has-data-[slot=alert-action]:pr-56' : 'has-data-[slot=alert-action]:pr-40',
        className,
      )}
    >
      <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden />
      <AlertTitle>{t('view.accountMoved', { agent })}</AlertTitle>
      <AlertDescription data-selectable="">{message}</AlertDescription>
      <AlertAction className="flex gap-1.5">
        {onRetry && (
          <Button size="xs" variant="outline" onClick={onRetry}>
            {t('common:actions.retry')}
          </Button>
        )}
        <Button size="xs" onClick={onOpen}>
          {t('view.openHarness', { name: to })}
        </Button>
      </AlertAction>
    </Alert>
  )
}
