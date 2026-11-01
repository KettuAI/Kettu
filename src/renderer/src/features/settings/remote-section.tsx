import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { CircleAlertIcon, ClockIcon, PlusIcon, SmartphoneIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PairedDevice } from '@shared/remote/device'
import type { RemoteStatus } from '@shared/remote/status'
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
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Badge } from '@renderer/components/ui/badge'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext, useHostHas } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { useRemoteStore } from '@renderer/stores/remote'
import { useSettingsStore } from '@renderer/stores/settings'
import { openSettingsItem } from '@renderer/stores/view'
import { useWebHostStore } from '@renderer/stores/web-host'
import { CONFIRM, ControlError, SettingSwitch } from './controls'
import { PairDialog } from './remote-pairing'
import { DeviceIcon, DeviceTile, OnlineDot } from './remote-parts'
import { daysToRemoval, daysUnseen, deviceLine, focusDirectPort, lastSeen } from './remote-text'
import { GroupNote, ItemRow } from './rows'
import { useApply } from './use-apply'

/** The page's title and line, with remote access's switch at their end. */
export function RemoteHeader({ id }: { id: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const onHost = useHostContext()
  const enabled = useSettingsStore((s) => s.settings.remote.enabled)
  const [apply, error] = useApply()
  const [asking, setAsking] = useState(false)
  // A daemon is reached only through remote access, so it has no switch to turn it off.
  const switchable = useHostHas('remoteSwitch')
  // In a browser, turning it off ends this page's own connection, so it asks first.
  const change = (on: boolean): void => {
    if (!on && isWeb) setAsking(true)
    else apply({ remote: { enabled: on } })
  }
  return (
    <header className="flex items-center gap-3.5 pb-7">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id={id} className="font-heading text-title font-medium text-balance">
          {t('sections.remote')}
        </h2>
        <p className="text-small text-pretty text-tertiary">{t('pages.remote', onHost)}</p>
      </div>
      <ControlError error={error} />
      {switchable !== false && (
        <SettingSwitch label={t('remote.switch')} checked={enabled} onChange={change} />
      )}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('remote.web.offTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('remote.web.offBody', onHost)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setAsking(false)
                apply({ remote: { enabled: false } })
              }}
            >
              {t('remote.web.offConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  )
}

/** "This browser" after the name of the device the web client is, in the list and on its page. */
export function ThisBrowserBadge({
  deviceId,
  className,
}: {
  deviceId: string
  className?: string
}) {
  const { t } = useTranslation('settings')
  const own = useWebHostStore((s) => s.host?.device.id === deviceId)
  if (!own) return null
  return (
    <Badge variant="neutral" className={className}>
      {t('remote.web.thisBrowser')}
    </Badge>
  )
}

/** The first line of the page: whether remote access runs, and the devices online. */
export function RemoteStatusRow({ status }: { status: RemoteStatus | null }) {
  const { t } = useTranslation('settings')
  if (!status || status.state === 'starting' || status.state === 'off') {
    return (
      <StatusLine>
        <Spinner className="size-3.5 text-icon" />
        {t('remote.status.starting')}
      </StatusLine>
    )
  }
  if (status.state === 'failed') {
    return (
      <StatusLine hint={t('remote.status.failedHint')}>
        <CircleAlertIcon className="size-4 shrink-0 text-danger" />
        {t('remote.status.failed')}
      </StatusLine>
    )
  }
  const { direct } = status
  if (direct.state === 'failed') {
    return (
      <StatusLine
        hint={t(`remote.status.cannotListenHint.${direct.reason}`)}
        actions={<RetryDirect />}
      >
        <CircleAlertIcon className="size-4 shrink-0 text-danger" />
        {t('remote.status.cannotListen', { port: direct.port })}
      </StatusLine>
    )
  }
  const online = status.online.length
  const devices =
    status.devices.length === 0
      ? t('remote.status.noDevices')
      : online > 0
        ? t('remote.status.online', { count: online })
        : t('remote.status.noneOnline')
  const parts = [t('remote.status.on')]
  if (direct.state === 'listening') parts.push(t('remote.status.listening', { port: direct.port }))
  return (
    <StatusLine>
      <OnlineDot />
      {[...parts, devices].join(' · ')}
    </StatusLine>
  )
}

/** Change port and Retry, when the direct connections' port could not be opened. */
function RetryDirect() {
  const { t } = useTranslation('settings')
  const refresh = useRefresh()
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <Button variant="outline" size="sm" onClick={focusDirectPort}>
        {t('remote.status.changePort')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-busy={refresh.phase === 'turning'}
        disabled={refresh.phase === 'turning'}
        onClick={() => {
          setError(null)
          void refresh
            .run(() => window.kettu.remote.retryDirect())
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      >
        <RefreshIcon phase={refresh.phase} data-icon="inline-start" />
        {t('remote.status.retry')}
      </Button>
    </>
  )
}

function StatusLine({
  hint,
  actions,
  children,
}: {
  hint?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-13 items-center gap-6 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-ui font-medium">{children}</div>
        {hint && <p className="mt-0.5 text-xs leading-4 text-pretty text-secondary">{hint}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

/** The name devices show; emptied, it goes back to the system's. */
export function HostNameField({ label }: { label: string }) {
  const status = useRemoteStore((s) => s.status)
  const name = useSettingsStore((s) => s.settings.remote.name)
  const systemName = status?.systemName ?? ''
  const shown = name ?? systemName
  const [draft, setDraft] = useState<string | null>(null)
  const [apply, error] = useApply()
  const commit = (): void => {
    if (draft === null) return
    const next = [...draft.trim()].slice(0, 64).join('').trim()
    setDraft(null)
    const kept = next === '' || next === systemName ? null : next
    if (kept !== name) apply({ remote: { name: kept } })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
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
        aria-label={label}
        value={draft ?? shown}
        placeholder={systemName}
        maxLength={256}
        spellCheck={false}
        autoComplete="off"
        className="h-7 w-50 text-ui md:text-ui"
        onFocus={() => setDraft(shown)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </>
  )
}

/** A paired device in the list, which opens its page. */
export function DeviceRow({ device, online }: { device: PairedDevice; online: boolean }) {
  const { t } = useTranslation('settings')
  const now = useNow()
  const removal = online ? null : daysToRemoval(device, now)
  return (
    <ItemRow
      item={device.id}
      label={device.name}
      onOpen={() => openSettingsItem('remote', device.id)}
      tile={<DeviceTile icon={<DeviceIcon device={device} className="size-4" />} />}
      name={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{device.name}</span>
          <ThisBrowserBadge deviceId={device.id} />
        </span>
      }
      right={
        online ? (
          <span className="flex items-center gap-1.5 text-xs text-tertiary">
            <OnlineDot />
            {t('remote.devices.online')}
          </span>
        ) : removal !== null ? (
          <span className="flex items-center gap-1.25 text-xs text-warning">
            <ClockIcon className="size-3.5" />
            {t('remote.devices.removedIn', { count: removal })}
          </span>
        ) : (
          <span className="text-xs text-tertiary">{lastSeen(t, device, now)}</span>
        )
      }
    >
      <span className="truncate text-command leading-4.5 text-secondary">
        {deviceLine(t, device)}
      </span>
    </ItemRow>
  )
}

/** The row at the list's end that opens Add device; disabled while remote access is off. */
export function AddDeviceRow({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-3 rounded-[inherit] py-3 pr-3 pl-4 text-left text-ui text-secondary outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-primary focus-visible:shadow-[inset_0_0_0_2px_var(--focus)] disabled:pointer-events-none disabled:opacity-50"
      >
        <span className="grid size-7.5 shrink-0 place-items-center rounded-lg border border-dashed border-strong">
          <PlusIcon className="size-4" />
        </span>
        {t('remote.devices.add')}
      </button>
      <PairDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

/** The list before any device is added: what to do, and Add device. */
export function NoDevices() {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Empty className="px-6 py-7">
        <EmptyHeader className="max-w-md">
          <EmptyMedia variant="icon">
            <SmartphoneIcon />
          </EmptyMedia>
          <EmptyTitle>{t('remote.devices.emptyTitle')}</EmptyTitle>
          <EmptyDescription className="max-w-none">
            {t('remote.devices.emptyHint')}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            {t('remote.devices.add')}
          </Button>
        </EmptyContent>
      </Empty>
      <PairDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

/** Under the status, when the key is in a file because the system has no keyring. */
export function PlainKeyNote() {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const plain = useRemoteStore((s) => s.status?.plainTextKey === true)
  return plain ? <GroupNote>{t('remote.status.plainTextKey', onHost)}</GroupNote> : null
}

/** Under the list, while a device is in its last days before it is removed. */
export function StaleNote() {
  const { t } = useTranslation('settings')
  const status = useRemoteStore((s) => s.status)
  const now = useNow()
  const stale = (status?.devices ?? [])
    .filter((device) => !status?.online.includes(device.id))
    .map((device) => ({ device, left: daysToRemoval(device, now) }))
    .filter((entry): entry is { device: PairedDevice; left: number } => entry.left !== null)
  if (stale.length === 0) return null
  if (stale.length > 1) {
    return <GroupNote>{t('remote.devices.staleMany', { count: stale.length })}</GroupNote>
  }
  const { device, left } = stale[0]!
  return (
    <GroupNote>
      {t('remote.devices.staleOne', {
        name: device.name,
        days: daysUnseen(device, now),
        count: left,
      })}
    </GroupNote>
  )
}

/** Allow terminal: whether devices may use this computer's terminal. */
export function TerminalSwitch({ label }: { label: string }) {
  const checked = useSettingsStore((s) => s.settings.remote.terminal)
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => apply({ remote: { terminal: v } })}
      />
    </>
  )
}

/** Reset remote access, after a confirm naming how many devices go. */
export function ResetRemote() {
  const { t } = useTranslation(['settings', 'common'])
  const onHost = useHostContext()
  const count = useRemoteStore((s) => s.status?.devices.length ?? 0)
  const on = useRemoteStore((s) => s.status?.state === 'on')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reset = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.kettu.remote.reset()
      setOpen(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <ControlError error={open ? null : error} />
      <Button
        variant="destructive-outline"
        size="sm"
        disabled={!on || busy}
        onClick={() => setOpen(true)}
      >
        {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
        {t('remote.reset.button')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('remote.reset.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {count > 0
                ? t('remote.reset.body', { count, ...onHost })
                : t('remote.reset.bodyNone', onHost)}
              {/* This browser is one of the devices, so its page goes back to pairing. */}
              {isWeb && ` ${t('remote.web.resetBody')}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-xs text-danger">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void reset()}>
              {t('remote.reset.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
