import { SmartPhone01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { useDevicesStore } from '@renderer/stores/devices'
import { SetButton } from './controls'
import { ItemLine, Thing } from './rows'

/** An always-allowed device: its name while the host still sees it, its id, and Remove. */
export function AllowedDeviceRow({
  deviceId,
  onForget,
}: {
  deviceId: string
  onForget: () => void
}) {
  const { t } = useTranslation('settings')
  const device = useDevicesStore((s) => s.devices.find((entry) => entry.id === deviceId))
  return (
    <div className="ui-sg-row">
      <Thing mark={<Icon icon={SmartPhone01Icon} size={20} />} name={device?.name ?? deviceId}>
        <ItemLine>{device ? deviceId : t('devices.allowed.notFound')}</ItemLine>
      </Thing>
      <SetButton onClick={onForget}>{t('devices.allowed.remove')}</SetButton>
    </div>
  )
}
