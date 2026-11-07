import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { addressKey, addressText, parseAddress } from '@shared/remote/address'
import { DEVICE_NAME_CHARS } from '@shared/remote/device'
import { MAX_HOST_ADDRESSES, type HostStatus } from '@shared/remote/hosts'
import type { DirectAddress } from '@shared/remote/protocol'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { monthDay } from '@renderer/lib/format'
import { isAway, useHostsStore } from '@renderer/stores/hosts'
import { openSettingsItem } from '@renderer/stores/view'
import { Fact } from './agent-parts'
import { CONFIRM, ControlError, DangerButton, IconAction, SetButton, SetInput } from './controls'
import { AddHostDialog } from './host-add'
import { openHostSettings } from './host-sections'
import { changeHost, platformName, routeName, routeText } from './host-text'
import { HostState } from './hosts-section'
import { DeviceTile, HostIcon } from './remote-parts'
import { GroupLabel, GroupNote, ItemPageHeader, Notice, RowFrame, RowGroup, RowText } from './rows'
import {
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from './settings-dialog'

const back = () => openSettingsItem('hosts', null)

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

/**
 * A known host's page: whether it is online, how it is reached and at which addresses, this
 * computer's name on it, and forgetting it here.
 */
export function HostPage({ id }: { id: string }) {
  const { t } = useTranslation('settings')
  const host = useHostsStore((s) => s.status?.hosts?.find((entry) => entry.id === id) ?? null)
  // Kept past the host: adding it over SSH again replaces it with one of a new id.
  const [again, setAgain] = useState<{ ssh?: string } | null>(null)
  return (
    <>
      {host ? (
        <HostPageBody host={host} onAddAgain={() => setAgain({ ssh: host.ssh?.target })} />
      ) : (
        <>
          <ItemPageHeader
            back={t('sections.hosts')}
            onBack={back}
            item={id}
            icon={null}
            title={null}
          />
          <p className="ui-sg-hint">{t('hosts.page.gone')}</p>
        </>
      )}
      <AddHostDialog
        open={again !== null}
        onOpenChange={(open) => {
          if (!open) setAgain(null)
        }}
        ssh={again?.ssh}
        onAdded={(added) => openSettingsItem('hosts', added.id)}
      />
    </>
  )
}

function HostPageBody({ host, onAddAgain }: { host: HostStatus; onAddAgain: () => void }) {
  const { t } = useTranslation('settings')
  const { name } = host
  return (
    <>
      <ItemPageHeader
        back={t('sections.hosts')}
        onBack={back}
        item={host.id}
        icon={<DeviceTile large icon={<HostIcon platform={host.platform} />} />}
        title={name}
        subtitle={[
          platformName(host.platform),
          t('hosts.version', { version: host.version }),
          t('hosts.page.added', { date: monthDay(host.addedAt) }),
        ].join(' · ')}
      >
        <HostState host={host} />
      </ItemPageHeader>

      <div className="k-groups">
        <StoppedNotice host={host} onAddAgain={onAddAgain} />
        <section aria-label={t('hosts.page.connection')} className="k-group">
          <GroupLabel group={{ id: 'connection', label: t('hosts.page.connection') }} />
          <RowGroup>
            {/* The SSH address has a row of its own. */}
            <Fact name={t('hosts.page.route')}>
              {host.ssh ? routeName(t, host) : routeText(t, host)}
            </Fact>
            {host.ssh ? (
              <Fact name={t('hosts.page.sshTarget')} mono>
                <span data-selectable="">{host.ssh.target}</span>
              </Fact>
            ) : (
              <RowFrame
                text={
                  <RowText
                    name={t('hosts.page.addresses')}
                    description={
                      <span data-selectable="" className="k-mono">
                        {host.addresses.map(addressText).join('　')}
                      </span>
                    }
                  />
                }
              >
                <EditAddresses host={host} />
              </RowFrame>
            )}
          </RowGroup>
          <GroupNote>
            {host.ssh
              ? t('hosts.page.sshNote', { name, target: host.ssh.target })
              : t('hosts.page.addressesNote', { name })}
          </GroupNote>
        </section>
        <section aria-label={t('hosts.page.self', { name })} className="k-group">
          <GroupLabel group={{ id: 'self', label: t('hosts.page.self', { name }) }} />
          <RowGroup>
            <RowFrame
              text={
                <RowText
                  name={t('hosts.page.name')}
                  description={
                    host.connection.state === 'online'
                      ? t('hosts.page.nameDescription', { name })
                      : t('hosts.page.nameOffline', { name })
                  }
                />
              }
            >
              <DeviceNameField host={host} />
            </RowFrame>
          </RowGroup>
        </section>
        <section aria-label={t('hostPicker.label')} className="k-group">
          <RowGroup>
            <RowFrame
              text={
                <RowText
                  name={t('hosts.page.settings.name', { name })}
                  description={t('hosts.page.settings.description', { name })}
                />
              }
            >
              <SetButton
                disabled={isAway(host.connection)}
                onClick={() => openHostSettings(host.id)}
              >
                {t('hosts.page.settings.open', { name })}
              </SetButton>
            </RowFrame>
          </RowGroup>
        </section>
        <section aria-label={t('hosts.page.remove.name')} className="k-group">
          <RowGroup>
            <RowFrame
              text={
                <RowText
                  name={t('hosts.page.remove.name')}
                  description={t('hosts.page.remove.description', { name })}
                />
              }
            >
              <RemoveHost host={host} />
            </RowFrame>
          </RowGroup>
        </section>
      </div>
    </>
  )
}

/** Why a host is not connected for good, or until one side's Kettu is updated. */
function StoppedNotice({ host, onAddAgain }: { host: HostStatus; onAddAgain: () => void }) {
  const { t } = useTranslation('settings')
  if (host.connection.state !== 'stopped') return null
  const { reason } = host.connection
  return (
    <Notice
      variant="warning"
      title={t(`hosts.page.${reason}.title`, { name: host.name })}
      action={
        reason === 'removed' && (
          <SetButton onClick={onAddAgain}>{t('hosts.page.removed.action')}</SetButton>
        )
      }
    >
      {reason === 'removed' && host.ssh
        ? t('hosts.page.removed.sshBody')
        : t(`hosts.page.${reason}.body`, { name: host.name })}
    </Notice>
  )
}

/** This computer's name on the host, which changes while the host is online. */
function DeviceNameField({ host }: { host: HostStatus }) {
  const { t } = useTranslation('settings')
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const online = host.connection.state === 'online'
  const commit = (): void => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next === '' || next === host.deviceName || [...next].length > DEVICE_NAME_CHARS) return
    void changeHost(t, host, () => window.kettu.hosts.rename(host.id, next)).then(setError)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (isComposing(event)) return
    if (event.key === 'Enter') event.currentTarget.blur()
    else if (event.key === 'Escape') {
      event.stopPropagation()
      setDraft(null)
      event.currentTarget.blur()
    }
  }
  return (
    <>
      <ControlError error={error} />
      <SetInput
        aria-label={t('hosts.add.nameLabel', { name: host.name })}
        value={draft ?? host.deviceName}
        disabled={!online}
        maxLength={256}
        spellCheck={false}
        autoComplete="off"
        className="k-input--wide"
        onFocus={() => {
          setError(null)
          setDraft(host.deviceName)
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </>
  )
}

/** Edit… beside the addresses, and the dialog that edits them with the checks of own addresses. */
function EditAddresses({ host }: { host: HostStatus }) {
  const { t } = useTranslation(['settings', 'common'])
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<DirectAddress[]>(host.addresses)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<'format' | 'repeat' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const errorId = useId()
  const full = list.length >= MAX_HOST_ADDRESSES
  const unchanged =
    JSON.stringify(list.map(addressKey)) === JSON.stringify(host.addresses.map(addressKey))
  const add = (event: FormEvent): void => {
    event.preventDefault()
    if (draft.trim() === '' || full) return
    const address = parseAddress(draft)
    if (!address) return setProblem('format')
    if (list.some((kept) => addressKey(kept) === addressKey(address))) return setProblem('repeat')
    setList([...list, address])
    setDraft('')
    setProblem(null)
  }
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const failed = await changeHost(t, host, () => window.kettu.hosts.setAddresses(host.id, list))
    setBusy(false)
    if (failed) setError(failed)
    else setOpen(false)
  }
  return (
    <>
      <SetButton onClick={() => setOpen(true)}>{t('hosts.page.edit')}</SetButton>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setList(host.addresses)
            setDraft('')
            setProblem(null)
            setError(null)
          }
          setOpen(next)
        }}
      >
        <SettingsDialogContent>
          <SettingsDialogHeader title={t('hosts.page.editTitle', { name: host.name })}>
            {t('hosts.page.editBody')}
          </SettingsDialogHeader>
          <SettingsDialogBody>
            {list.length > 0 && (
              <ul className="kettu-sd__list">
                {list.map((address) => {
                  const shown = addressText(address)
                  return (
                    <li key={addressKey(address)} className="kettu-sd__address">
                      <span data-selectable="" className="k-mono k-name">
                        {shown}
                      </span>
                      <IconAction
                        label={t('remote.direct.own.remove', { address: shown })}
                        icon={Cancel01Icon}
                        onClick={() => setList(list.filter((kept) => kept !== address))}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
            {!full && (
              <form className="kettu-sd__inline" onSubmit={add}>
                <input
                  value={draft}
                  autoFocus
                  aria-label={t('remote.direct.own.label')}
                  aria-invalid={problem !== null || undefined}
                  aria-describedby={problem ? errorId : undefined}
                  placeholder={t('remote.direct.own.placeholder')}
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={300}
                  className={DIALOG_MONO_FIELD}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    setProblem(null)
                  }}
                />
                <SetButton size="md" type="submit" disabled={draft.trim() === ''}>
                  {t('remote.direct.own.add')}
                </SetButton>
              </form>
            )}
            {problem && (
              <p id={errorId} className="kettu-sd__error">
                {problem === 'repeat' ? (
                  t('remote.direct.own.repeat')
                ) : (
                  <Trans
                    t={t}
                    i18nKey="remote.direct.own.invalid"
                    components={{
                      strong: <span />,
                      code: <span className="k-mono" />,
                    }}
                  />
                )}
              </p>
            )}
            {error && <p className="kettu-sd__error">{error}</p>}
          </SettingsDialogBody>
          <SettingsDialogFooter>
            <DialogClose render={<SetButton size="md" variant="ghost" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <SetButton
              size="md"
              variant="primary"
              loading={busy}
              disabled={unchanged || list.length === 0}
              onClick={() => void save()}
            >
              {t('hosts.page.save')}
            </SetButton>
          </SettingsDialogFooter>
        </SettingsDialogContent>
      </Dialog>
    </>
  )
}

function RemoveHost({ host }: { host: HostStatus }) {
  const { t } = useTranslation(['settings', 'common'])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const failed = await changeHost(t, host, () => window.kettu.hosts.remove(host.id))
    if (failed) {
      setError(failed)
      setBusy(false)
      return
    }
    setOpen(false)
    back()
  }
  return (
    <>
      <ControlError error={open ? null : error} />
      <DangerButton onClick={() => setOpen(true)}>{t('hosts.page.remove.button')}</DangerButton>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('hosts.page.remove.title', { name: host.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('hosts.page.remove.body', { name: host.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-xs text-danger">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
              {t('hosts.page.remove.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
