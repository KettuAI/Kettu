import { useState } from 'react'
import { BrowserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { ComputerApp, ComputerPermission, ComputerPermissionKind } from '@shared/computer-use'
import { Icon } from '@renderer/components/affect/app-shell'
import { errorMessage } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'
import { ControlError, Pill, SetButton, SettingSwitch } from './controls'
import { ItemLine, Thing } from './rows'

/** The switch, on this computer's own settings whichever host the page shows. */
export function ComputerSwitch({ label }: { label: string }) {
  const checked = useSettingsStore((s) => s.settings.computerUse.enabled)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(enabled) => {
          setError(null)
          useSettingsStore
            .getState()
            .update({ computerUse: { enabled } })
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
    </>
  )
}

export function PermissionRow({
  kind,
  state,
  onChanged,
}: {
  kind: ComputerPermissionKind
  state: ComputerPermission
  onChanged: () => void
}) {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ask = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.kettu.computer.requestPermission(kind)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  if (state === 'granted') return <Pill tone="success">{t('computer.permission.granted')}</Pill>
  return (
    <>
      <ControlError error={error} />
      <SetButton loading={busy} onClick={() => void ask()}>
        {state === 'denied' ? t('computer.permission.open') : t('computer.permission.ask')}
      </SetButton>
    </>
  )
}

export function AllowedAppRow({ app, onRemove }: { app: ComputerApp; onRemove: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className="ui-sg-row">
      <Thing mark={<Icon icon={BrowserIcon} size={20} />} name={app.name}>
        <ItemLine>{app.id}</ItemLine>
      </Thing>
      <SetButton onClick={onRemove}>{t('computer.allowedApps.remove')}</SetButton>
    </div>
  )
}
