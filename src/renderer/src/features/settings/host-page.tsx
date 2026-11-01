import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import { CircleAlertIcon, XIcon } from 'lucide-react'
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
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { monthDay } from '@renderer/lib/format'
import { useHostsStore } from '@renderer/stores/hosts'
import { openSettingsItem } from '@renderer/stores/view'
import { Fact } from './agent-parts'
import { CONFIRM, ControlError } from './controls'
import { AddHostDialog } from './host-add'
import { changeHost, platformName, routeText } from './host-text'
import { HostState } from './hosts-section'
import { DeviceTile, HostIcon } from './remote-parts'
import { GroupLabel, GroupNote, ItemPageHeader, Notice, RowFrame, RowGroup, RowText } from './rows'

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
  if (!host) {
    return (
      <div className="flex flex-col">
        <ItemPageHeader
          back={t('sections.hosts')}
          onBack={back}
          item={id}
          icon={null}
          title={null}
        />
        <p className="px-1 text-small text-tertiary">{t('hosts.page.gone')}</p>
      </div>
    )
  }
  return <HostPageBody host={host} />
}

function HostPageBody({ host }: { host: HostStatus }) {
  const { t } = useTranslation('settings')
  const { name } = host
  return (
    <div className="flex flex-col">
      <ItemPageHeader
        back={t('sections.hosts')}
        onBack={back}
        item={host.id}
        icon={<DeviceTile large icon={<HostIcon platform={host.platform} className="size-5" />} />}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{name}</span>
            <HostState host={host} className="shrink-0 font-sans font-normal" />
          </span>
        }
      >
        <p className="truncate text-command leading-4.5 text-tertiary">
          {[
            platformName(host.platform),
            t('hosts.version', { version: host.version }),
            t('hosts.page.added', { date: monthDay(host.addedAt) }),
          ].join(' · ')}
        </p>
      </ItemPageHeader>

      <div className="flex flex-col gap-7">
        <StoppedNotice host={host} />
        <section aria-label={t('hosts.page.connection')} className="flex flex-col">
          <GroupLabel group={{ id: 'connection', label: t('hosts.page.connection') }} />
          <RowGroup>
            <Fact name={t('hosts.page.route')}>{routeText(t, host.connection)}</Fact>
            <RowFrame
              compact
              text={
                <RowText
                  name={t('hosts.page.addresses')}
                  description={
                    <span data-selectable="" className="font-mono text-code text-secondary">
                      {host.addresses.map(addressText).join('　')}
                    </span>
                  }
                />
              }
            >
              <EditAddresses host={host} />
            </RowFrame>
          </RowGroup>
          <GroupNote>{t('hosts.page.addressesNote', { name })}</GroupNote>
        </section>
        <section aria-label={t('hosts.page.self', { name })} className="flex flex-col">
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
        <section aria-label={t('hosts.page.remove.name')} className="flex flex-col">
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
    </div>
  )
}

/** Why a host is not connected for good, or until one side's Kettu is updated. */
function StoppedNotice({ host }: { host: HostStatus }) {
  const { t } = useTranslation('settings')
  const [adding, setAdding] = useState(false)
  if (host.connection.state !== 'stopped') return null
  const { reason } = host.connection
  return (
    <>
      <Notice
        variant="warning"
        icon={<CircleAlertIcon />}
        title={t(`hosts.page.${reason}.title`, { name: host.name })}
        action={
          reason === 'removed' && (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              {t('hosts.page.removed.action')}
            </Button>
          )
        }
      >
        {t(`hosts.page.${reason}.body`, { name: host.name })}
      </Notice>
      {reason === 'removed' && <AddHostDialog open={adding} onOpenChange={setAdding} />}
    </>
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
      <Input
        aria-label={t('hosts.add.nameLabel', { name: host.name })}
        value={draft ?? host.deviceName}
        disabled={!online}
        maxLength={256}
        spellCheck={false}
        autoComplete="off"
        className="h-7 w-55 text-ui md:text-ui"
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
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('hosts.page.edit')}
      </Button>
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('hosts.page.editTitle', { name: host.name })}</DialogTitle>
            <DialogDescription>{t('hosts.page.editBody')}</DialogDescription>
          </DialogHeader>
          {list.length > 0 && (
            <ul className="flex flex-col">
              {list.map((address) => {
                const shown = addressText(address)
                return (
                  <li key={addressKey(address)} className="flex min-h-7 items-center gap-3">
                    <span
                      data-selectable=""
                      className="min-w-0 flex-1 truncate font-mono text-code"
                    >
                      {shown}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('remote.direct.own.remove', { address: shown })}
                      onClick={() => setList(list.filter((kept) => kept !== address))}
                    >
                      <XIcon />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          {!full && (
            <form className="flex items-center gap-2" onSubmit={add}>
              <Input
                value={draft}
                autoFocus
                aria-label={t('remote.direct.own.label')}
                aria-invalid={problem !== null || undefined}
                aria-describedby={problem ? errorId : undefined}
                placeholder={t('remote.direct.own.placeholder')}
                spellCheck={false}
                autoComplete="off"
                maxLength={300}
                className="h-7 font-mono text-code md:text-code"
                onChange={(event) => {
                  setDraft(event.target.value)
                  setProblem(null)
                }}
              />
              <Button type="submit" variant="outline" size="sm" disabled={draft.trim() === ''}>
                {t('remote.direct.own.add')}
              </Button>
            </form>
          )}
          {problem && (
            <p id={errorId} className="flex items-start gap-1.25 text-xs text-secondary">
              <CircleAlertIcon className="mt-px size-3.5 shrink-0 text-danger" />
              <span>
                {problem === 'repeat' ? (
                  t('remote.direct.own.repeat')
                ) : (
                  <Trans
                    t={t}
                    i18nKey="remote.direct.own.invalid"
                    components={{
                      strong: <span className="text-danger" />,
                      code: <span className="font-mono text-primary" />,
                    }}
                  />
                )}
              </span>
            </p>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button disabled={busy || unchanged || list.length === 0} onClick={() => void save()}>
              {busy && <Spinner data-icon="inline-start" />}
              {t('hosts.page.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
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
      <Button variant="destructive-outline" size="sm" onClick={() => setOpen(true)}>
        {t('hosts.page.remove.button')}
      </Button>
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
