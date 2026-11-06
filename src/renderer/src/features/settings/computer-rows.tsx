import { useState } from 'react'
import { AppWindowIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ComputerApp, ComputerPermission, ComputerPermissionKind } from '@shared/computer-use'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'
import { ControlError, Pill, ROW_BUTTON, SettingSwitch } from './controls'
import { DeviceTile } from './remote-parts'
import { ItemLine } from './rows'

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
      <Button variant="outline" className={ROW_BUTTON} disabled={busy} onClick={() => void ask()}>
        {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
        {state === 'denied' ? t('computer.permission.open') : t('computer.permission.ask')}
      </Button>
    </>
  )
}

export function AllowedAppRow({ app, onRemove }: { app: ComputerApp; onRemove: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex items-center gap-3.5 py-3.25">
      <DeviceTile icon={<AppWindowIcon className="size-4" />} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-label leading-[normal]">{app.name}</span>
        <ItemLine>{app.id}</ItemLine>
      </div>
      <Button variant="ghost" className={ROW_BUTTON} onClick={onRemove}>
        {t('computer.allowedApps.remove')}
      </Button>
    </div>
  )
}
