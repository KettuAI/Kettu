import { ComputerPhoneSyncIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRemoteStore } from '@renderer/stores/remote'
import { openSettings } from '@renderer/stores/view'

/** Remote access, with a green dot while a paired phone or computer is online. */
export function RemoteButton() {
  const { t } = useTranslation('sidebar')
  const devices = useRemoteStore((s) => s.status?.devices.length ?? 0)
  const online = useRemoteStore((s) => (s.status?.online.length ?? 0) > 0)
  const label = t('account.remote', { count: devices })
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => openSettings('remote')}
      className="ui-as-icon-btn ui-as-user-action"
    >
      <Icon icon={ComputerPhoneSyncIcon} size={16} />
      {online && <span aria-hidden className="ui-as-user-action__dot kettu-remote-dot" />}
    </button>
  )
}
