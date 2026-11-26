import { useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DEVICE_NAME_CHARS } from '@shared/remote/device'
import type { HostStatus } from '@shared/remote/hosts'
import { changeHost, platformName, routeName, routeText } from './host-text'
import { SetButton } from './controls'
import { DeviceTile, HostIcon } from './remote-parts'
import {
  DIALOG_FIELD,
  SettingsDialogBody,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

/**
 * The host just added or updated: for a newly added host, this computer's name on it can be
 * changed on the spot; for an already-paired host whose relay/addresses were updated via a new
 * pairing link, shows clear confirmation of the refreshed connection.
 */
export function Added({
  host,
  updated = false,
  title,
  note,
  onDone,
}: {
  host: HostStatus
  /** True when the link updated an already-paired host rather than adding a new one. */
  updated?: boolean
  /** The dialog's title, when it is not Add host. */
  title?: string
  /** A line under the host, as whether it may use this computer too. */
  note?: ReactNode
  onDone: () => void
}) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState(host.deviceName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const valid = updated || (trimmed.length > 0 && [...trimmed].length <= DEVICE_NAME_CHARS)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    if (updated || trimmed === host.deviceName) return onDone()
    setBusy(true)
    const failed = await changeHost(t, host, () => window.kettu.hosts.rename(host.id, trimmed))
    if (!failed) return onDone()
    setError(failed)
    setBusy(false)
  }
  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={title ?? t('hosts.add.title')} />
      <SettingsDialogBody>
        <div className="kettu-sd__row">
          <DeviceTile large icon={<HostIcon platform={host.platform} />} />
          <span className="ui-sg-label">
            <b>{t(updated ? 'hosts.add.updated' : 'hosts.add.added', { name: host.name })}</b>
            <small>
              {[
                platformName(host.platform),
                t('hosts.version', { version: host.version }),
                updated ? routeText(t, host) : routeName(t, host),
              ].join(' · ')}
            </small>
          </span>
        </div>
        {updated && (
          <p className="kettu-sd__text">{t('hosts.add.updatedBody', { name: host.name })}</p>
        )}
        {note}
        {!updated && (
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
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <SetButton
          size="md"
          variant="primary"
          type="submit"
          autoFocus={updated}
          loading={busy}
          disabled={!valid}
        >
          {t('hosts.add.done')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}
