import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { DEVICE_NAME_CHARS } from '@shared/remote/device'
import type { HostStatus } from '@shared/remote/hosts'
import { changeHost, platformName, routeName } from './host-text'
import { SetButton } from './controls'
import { DeviceTile, HostIcon } from './remote-parts'
import {
  DIALOG_FIELD,
  SettingsDialogBody,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

/** The host just added, and this computer's name on it, which changes on Done. */
export function Added({ host, onDone }: { host: HostStatus; onDone: () => void }) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState(host.deviceName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const valid = trimmed.length > 0 && [...trimmed].length <= DEVICE_NAME_CHARS
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    if (trimmed === host.deviceName) return onDone()
    setBusy(true)
    const failed = await changeHost(t, host, () => window.kettu.hosts.rename(host.id, trimmed))
    if (!failed) return onDone()
    setError(failed)
    setBusy(false)
  }
  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('hosts.add.title')} />
      <SettingsDialogBody>
        <div className="kettu-sd__row">
          <DeviceTile large icon={<HostIcon platform={host.platform} />} />
          <span className="ui-sg-label">
            <b>{t('hosts.add.added', { name: host.name })}</b>
            <small>
              {[
                platformName(host.platform),
                t('hosts.version', { version: host.version }),
                routeName(t, host),
              ].join(' · ')}
            </small>
          </span>
        </div>
        <SettingsField
          label={t('hosts.add.nameLabel', { name: host.name })}
          htmlFor="host-device-name"
          hint={
            error ? (
              <span className="kettu-sd__error">{error}</span>
            ) : (
              t('hosts.add.nameHint', { name: host.name })
            )
          }
        >
          <input
            id="host-device-name"
            value={name}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className={DIALOG_FIELD}
            aria-invalid={!valid || error !== null || undefined}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
          />
        </SettingsField>
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <SetButton size="md" variant="primary" type="submit" loading={busy} disabled={!valid}>
          {t('hosts.add.done')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}
