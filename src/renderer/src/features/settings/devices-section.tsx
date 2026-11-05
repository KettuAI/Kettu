import { useEffect, useState } from 'react'
import { SmartphoneIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { errorMessage, host } from '@renderer/lib/host'
import { loadDevices, useDevicesStore } from '@renderer/stores/devices'
import { useViewStore } from '@renderer/stores/view'
import { ROW_BUTTON } from './controls'
import type { RowDef, SectionDef } from './model'
import { DeviceTile } from './remote-parts'
import { ItemLine } from './rows'

/**
 * The devices agents may always use on this host, read each time the page shows; removing one
 * makes its next agent ask again.
 */
function useAllowedDevices(): {
  ids: string[] | null
  error: string | null
  forget: (deviceId: string) => void
} {
  const shown = useViewStore((s) => s.settings.open && s.settings.section === 'devices')
  const [ids, setIds] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!shown) return
    let cancelled = false
    void loadDevices()
    host('devices.allowed', {}).then(
      (result) => !cancelled && setIds(result.deviceIds),
      (caught: unknown) => !cancelled && setError(errorMessage(caught)),
    )
    return () => {
      cancelled = true
    }
  }, [shown])
  const forget = (deviceId: string): void => {
    void host('devices.forget', { deviceId }).then(
      () => setIds((current) => current?.filter((id) => id !== deviceId) ?? null),
      (caught: unknown) => setError(errorMessage(caught)),
    )
  }
  return { ids, error, forget }
}

function AllowedDeviceRow({ deviceId, onForget }: { deviceId: string; onForget: () => void }) {
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

export function useDevicesSection(): SectionDef {
  const { t } = useTranslation('settings')
  const { ids, error, forget } = useAllowedDevices()
  const group = { id: 'allowed-devices', label: t('devices.groups.allowed'), count: ids?.length }
  const rows: RowDef[] = [
    {
      id: 'allowed-devices',
      name: t('devices.allowed.name'),
      description: t('devices.allowed.description'),
      keywords: t('devices.allowed.keywords'),
      searchOnly: !!ids?.length,
      group,
      layout: 'custom',
      render: () => (
        <p className="py-3.25 text-hint text-tertiary">
          {error ?? (ids === null ? t('devices.allowed.loading') : t('devices.allowed.none'))}
        </p>
      ),
    },
    ...(ids ?? []).map((deviceId): RowDef => ({
      id: `device-${deviceId}`,
      name: deviceId,
      keywords: t('devices.allowed.keywords'),
      group,
      layout: 'custom',
      render: () => <AllowedDeviceRow deviceId={deviceId} onForget={() => forget(deviceId)} />,
    })),
  ]
  return {
    id: 'devices',
    title: t('sections.devices'),
    description: t('pages.devices'),
    icon: SmartphoneIcon,
    rows,
  }
}
