import { useTranslation } from 'react-i18next'
import type { HostConnection } from '@shared/remote/hosts'
import { Button } from '@renderer/components/ui/button'
import { isWeb } from '@renderer/lib/platform'
import { signIn, useAccountStore } from '@renderer/stores/account'
import { useSettingsStore } from '@renderer/stores/settings'
import { openSettings } from '@renderer/stores/view'

type Action = 'signIn' | 'account' | 'update' | 'reconnect'

/** What this computer can do about a host it does not reach, by why; null when nothing here. */
function actionFor(connection: HostConnection, cloudOn: boolean): Action | null {
  if (connection.state === 'stopped') return connection.reason === 'update_client' ? 'update' : null
  if (connection.state !== 'offline') return null
  if (cloudOn && connection.relay === 'signed_out') return 'signIn'
  if (cloudOn && connection.relay === 'wrong_account') return 'account'
  return 'reconnect'
}

/** The button of a host's offline line that acts on why it is not reached. */
export function HostAwayAction({
  connection,
  className,
}: {
  connection: HostConnection
  className?: string
}) {
  const { t } = useTranslation('settings')
  const cloudOn = useSettingsStore((s) => s.settings.cloud.enabled)
  const signingIn = useAccountStore((s) => s.status?.state === 'signing-in')
  const action = isWeb ? null : actionFor(connection, cloudOn)
  if (!action) return null
  const props = {
    variant: 'outline',
    size: 'sm',
    className,
  } as const
  switch (action) {
    case 'signIn':
      return (
        <Button {...props} disabled={signingIn} onClick={() => void signIn()}>
          {t('account.signIn')}
        </Button>
      )
    case 'account':
      return (
        <Button {...props} onClick={() => openSettings('account')}>
          {t('hosts.away.switchAccount')}
        </Button>
      )
    case 'update':
      return (
        <Button {...props} onClick={() => openSettings('about')}>
          {t('about.updates.update')}
        </Button>
      )
    case 'reconnect':
      return (
        <Button {...props} onClick={() => void window.kettu.hosts.retry()}>
          {t('hosts.away.reconnect')}
        </Button>
      )
  }
}
