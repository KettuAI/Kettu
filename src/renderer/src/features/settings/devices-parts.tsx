import { SmartphoneIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { useDevicesStore } from '@renderer/stores/devices'
import { ROW_BUTTON } from './controls'
import { DeviceTile } from './remote-parts'
import { ItemLine } from './rows'

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
    <div className="flex items-center gap-3.5 py-3.25">
      <DeviceTile icon={<SmartphoneIcon className="size-4" />} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-label leading-[normal]">{device?.name ?? deviceId}</span>
        <ItemLine>{device ? deviceId : t('devices.allowed.notFound')}</ItemLine>
      </div>
      <Button variant="ghost" className={ROW_BUTTON} onClick={onForget}>
        {t('devices.allowed.remove')}
      </Button>
    </div>
  )
}
