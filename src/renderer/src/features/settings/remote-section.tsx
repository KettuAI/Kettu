import { useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Add01Icon,
  AlertCircleIcon,
  RefreshIcon,
  SmartPhone01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
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
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext, useHostHas } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { useHostScope } from '@renderer/stores/host-scope'
import { openSettingsItem } from '@renderer/stores/view'
import { useWebHostStore } from '@renderer/stores/web-host'
import {
  CONFIRM,
  ControlError,
  DangerButton,
  Pill,
  SetButton,
  SetInput,
  SettingSwitch,
  Spin,
} from './controls'
import { PairDialog } from './remote-pairing'
import { DeviceIcon, DeviceTile } from './remote-parts'
import { RelaySignIn, RetryRelay } from './remote-relay'
import { useRelayLine } from './relay-text'
import { daysToRemoval, daysUnseen, focusDirectPort, kindLabel, lastSeen } from './remote-text'
import { GroupNote, ItemLine, ItemRow } from './rows'
import { useApply } from './use-apply'

/** Remote access's switch, the first row: whether it runs and the devices online under it. */
export function RemoteSwitchRow() {
  const { hostId, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const onHost = useHostContext()
  const enabled = useSettingsStore((s) => s.settings.remote.enabled)
  const [apply, error] = useApply()
  const [asking, setAsking] = useState(false)
  // A daemon is reached only through remote access, so it has no switch to turn it off.
  const switchable = useHostHas('remoteSwitch')
  // From a browser or another computer, turning it off ends this device's own connection, so it
  // asks first.
  const change = (on: boolean): void => {
    if (!on && (isWeb || hostId !== null)) setAsking(true)
    else apply({ remote: { enabled: on } })
  }
  return (
    <>
      <div className="ui-sg-row">
        <span className="ui-sg-label">
          <b>{t('remote.switch')}</b>
          <RemoteStatusLine on={enabled} />
        </span>
        <span className="ui-sg-control">
          <ControlError error={error} />
          {switchable !== false && (
            <SettingSwitch label={t('remote.switch')} checked={enabled} onChange={change} />
          )}
        </span>
      </div>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('remote.web.offTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(isWeb ? 'remote.web.offBody' : 'remote.other.offBody', onHost)}
            </AlertDialogDescription>
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
    </>
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
  return <Pill className={className}>{t('remote.web.thisBrowser')}</Pill>
}

/** Under the status card's title: whether remote access runs, and the devices online. */
function RemoteStatusLine({ on }: { on: boolean }) {
  const { useRemoteStore } = useHostScope()
  const { t } = useTranslation('settings')
  const status = useRemoteStore((s) => s.status)
  if (on) return <RemoteStatusRow status={status} />
  return (
    <StatusLine>
      <span aria-hidden className="k-dot" />
      {t('remote.status.offLine')}
    </StatusLine>
  )
}

/** The status line while remote access is on: whether it runs, and the devices online. */
export function RemoteStatusRow({ status }: { status: RemoteStatus | null }) {
  const { t } = useTranslation('settings')
  const relay = useRelayLine(status)
  if (!status || status.state === 'starting' || status.state === 'off') {
    return (
      <StatusLine>
        <Spin />
        {t('remote.status.starting')}
      </StatusLine>
    )
  }
  if (status.state === 'failed') {
    return (
      <StatusLine hint={t('remote.status.failedHint')} failed>
        <Icon icon={AlertCircleIcon} size={14} />
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
        failed
      >
        <Icon icon={AlertCircleIcon} size={14} />
        {t('remote.status.cannotListen', { port: direct.port })}
      </StatusLine>
    )
  }
  if (relay.problem) {
    return (
      <StatusLine hint={relay.problem.hint} actions={<RetryRelay />} failed>
        <Icon icon={AlertCircleIcon} size={14} />
        {relay.problem.text}
      </StatusLine>
    )
  }
  if (relay.connecting && direct.state !== 'listening') {
    return (
      <StatusLine>
        <Spin />
        {t('remote.relay.connecting')}
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
  if (relay.part) parts.push(relay.part)
  if (direct.state === 'listening') parts.push(t('remote.status.listening', { port: direct.port }))
  return (
    <StatusLine
      hint={relay.signInHint ?? undefined}
      actions={relay.signInHint ? <RelaySignIn /> : undefined}
    >
      <span aria-hidden className="k-dot" data-tone="ok" />
      {[...parts, devices].join(' · ')}
    </StatusLine>
  )
}

/** Change port and Retry, when the direct connections' port could not be opened. */
function RetryDirect() {
  const { api } = useHostScope()
  const { t } = useTranslation('settings')
  const refresh = useRefresh()
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SetButton onClick={focusDirectPort}>{t('remote.status.changePort')}</SetButton>
      <SetButton
        loading={refresh.phase === 'turning'}
        icon={<Icon icon={refresh.phase === 'done' ? Tick02Icon : RefreshIcon} size={14} />}
        onClick={() => {
          setError(null)
          void refresh
            .run(() => api.remote.retryDirect())
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      >
        {t('remote.status.retry')}
      </SetButton>
    </>
  )
}

function StatusLine({
  hint,
  actions,
  failed,
  children,
}: {
  hint?: string
  actions?: ReactNode
  failed?: boolean
  children: ReactNode
}) {
  return (
    <>
      <small className="k-status" data-failed={failed || undefined}>
        {children}
      </small>
      {hint && <small>{hint}</small>}
      {actions && <span className="k-status__actions">{actions}</span>}
    </>
  )
}

/** The name devices show; emptied, it goes back to the system's. */
export function HostNameField({ label }: { label: string }) {
  const { useSettingsStore, useRemoteStore } = useHostScope()
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
      <SetInput
        aria-label={label}
        value={draft ?? shown}
        placeholder={systemName}
        maxLength={256}
        spellCheck={false}
        autoComplete="off"
        className="k-input--wide"
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
      tile={<DeviceTile icon={<DeviceIcon device={device} />} />}
      name={
        <>
          <span className="k-name">{device.name}</span>
          <ThisBrowserBadge deviceId={device.id} />
        </>
      }
      right={
        online ? (
          <Pill tone="success">{t('remote.devices.online')}</Pill>
        ) : removal !== null ? (
          <Pill tone="warning">{t('remote.devices.removedIn', { count: removal })}</Pill>
        ) : (
          <Pill>{lastSeen(t, device, now)}</Pill>
        )
      }
    >
      <ItemLine>{kindLabel(t, device.kind)}</ItemLine>
    </ItemRow>
  )
}

/** Add device at the Devices heading's end; disabled while remote access is off. */
export function AddDeviceButton({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  return (
    <>
      <SetButton
        variant="primary"
        icon={<Icon icon={Add01Icon} size={14} />}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {t('remote.devices.add')}
      </SetButton>
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
      <div className="ui-as-empty" data-bare="">
        <span className="ui-as-empty__icon">
          <Icon icon={SmartPhone01Icon} size={18} />
        </span>
        <b className="ui-as-empty__title">{t('remote.devices.emptyTitle')}</b>
        <p className="ui-as-empty__text">{t('remote.devices.emptyHint')}</p>
        <span className="k-empty-actions">
          <SetButton
            variant="primary"
            icon={<Icon icon={Add01Icon} size={14} />}
            onClick={() => setOpen(true)}
          >
            {t('remote.devices.add')}
          </SetButton>
        </span>
      </div>
      <PairDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

/** Under the status, when the key is in a file, and why. */
export function PlainKeyNote() {
  const { useRemoteStore } = useHostScope()
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  const plain = useRemoteStore((s) => s.status?.plainTextKey === true)
  const service = useRemoteStore((s) => s.status?.service === true)
  if (!plain) return null
  return (
    <GroupNote>
      {t(service ? 'remote.status.serviceKey' : 'remote.status.plainTextKey', onHost)}
    </GroupNote>
  )
}

/** Under the list, while a device is in its last days before it is removed. */
export function StaleNote() {
  const { useRemoteStore } = useHostScope()
  const { t } = useTranslation('settings')
  const status = useRemoteStore((s) => s.status)
  const now = useNow()
  const stale = (status?.devices ?? [])
    .filter((device) => !status?.online.includes(device.id))
    .map((device) => ({ device, left: daysToRemoval(device, now) }))
    .filter((entry): entry is { device: PairedDevice; left: number } => entry.left !== null)
  if (stale.length === 0) return <GroupNote>{t('remote.devices.removalNote')}</GroupNote>
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
  const { useSettingsStore } = useHostScope()
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
  const { hostId, api, useRemoteStore } = useHostScope()
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
      await api.remote.reset()
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
      <DangerButton busy={busy} disabled={!on} onClick={() => setOpen(true)}>
        {t('remote.reset.button')}
      </DangerButton>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('remote.reset.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {count > 0
                ? t('remote.reset.body', { count, ...onHost })
                : t('remote.reset.bodyNone', onHost)}
              {/* This device is one of them, so it has to be added again. */}
              {isWeb && ` ${t('remote.web.resetBody')}`}
              {hostId !== null && ` ${t('remote.other.resetBody', onHost)}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-hint text-danger">{error}</p>}
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
