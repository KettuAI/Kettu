import { useEffect, useState, type ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  Alert02Icon,
  ArrowTurnBackwardIcon,
  Camera01Icon,
  ComputerPhoneSyncIcon,
  DashboardSquare01Icon,
  Home01Icon,
  Moon02Icon,
  MoreHorizontalIcon,
  PlayIcon,
  PlusSignIcon,
  RecordIcon,
  RefreshIcon,
  RotateClockwiseIcon,
  ShutDownIcon,
  SmartPhone01Icon,
  SquareLock02Icon,
  StopIcon,
  Sun03Icon,
  Tablet01Icon,
  Unlink01Icon,
  VolumeHighIcon,
  VolumeLowIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  SESSION_DEVICE_LIMIT,
  type DeviceAppearance,
  type DeviceButton,
  type DeviceInfo,
} from '@shared/device-host'
import { Button } from '@renderer/components/affect/button'
import { Badge } from '@renderer/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DrivingPill } from '@renderer/features/browser/driving-bar'
import {
  PaneHead,
  PaneIcon,
  PaneSheet,
  PaneSpinner,
  PanelButton,
} from '@renderer/features/shell/panel-button'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useSeconds } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { toast } from '@renderer/components/ui/toast'
import {
  closeDevice,
  devicesOf,
  loadDevices,
  moveDevice,
  openDevice,
  seenDevices,
  selectDevice,
  setDeviceStream,
  shutDownDevice,
  useDevicesStore,
  type DeviceStream,
} from '@renderer/stores/devices'
import { useSessionsStore } from '@renderer/stores/sessions'
import { panelSession } from '@renderer/stores/view'
import { canRecord, saveScreenshot, startRecording, stopRecording } from './device-capture'
import { DeviceRequest } from './device-request'
import { DeviceScreen } from './device-screen'
import { DeviceSetup, HostSetup } from './device-setup'

// The hardware buttons in groups: navigation, volume, then turning the device.
const BUTTONS: {
  button: DeviceButton
  platforms: DeviceInfo['platform'][]
  icon: IconSvgElement
}[][] = [
  [
    { button: 'back', platforms: ['android'], icon: ArrowTurnBackwardIcon },
    { button: 'home', platforms: ['ios', 'android'], icon: Home01Icon },
    { button: 'recents', platforms: ['android'], icon: DashboardSquare01Icon },
    { button: 'lock', platforms: ['ios', 'android'], icon: SquareLock02Icon },
  ],
  [
    { button: 'volumeDown', platforms: ['ios', 'android'], icon: VolumeLowIcon },
    { button: 'volumeUp', platforms: ['ios', 'android'], icon: VolumeHighIcon },
  ],
  [{ button: 'rotate', platforms: ['ios', 'android'], icon: RotateClockwiseIcon }],
]

/** A device's mark: one for simulators and emulators, the device's form for a physical one. */
function markOf(device: DeviceInfo): IconSvgElement {
  if (device.kind !== 'physical') return ComputerPhoneSyncIcon
  return /ipad|tablet|tab\b/i.test(`${device.name} ${device.model ?? ''}`)
    ? Tablet01Icon
    : SmartPhone01Icon
}

const DOT_COLOR = {
  neutral: 'text-disabled',
  info: 'text-info',
  warning: 'text-warning',
  error: 'text-danger',
} as const

/** A state as a badge, with a dot for one that is happening now. */
function State({
  variant,
  dot,
  compact,
  children,
}: {
  variant: 'neutral' | 'info' | 'warning' | 'error'
  dot?: 'still' | 'live'
  /** Only a dot in the state's color, where a tab has no room for the words. */
  compact?: boolean
  children: string
}) {
  if (compact) {
    return (
      <span
        role="img"
        aria-label={children}
        title={children}
        className={cn('kp-device-dot', DOT_COLOR[variant])}
      />
    )
  }
  return (
    <Badge variant={variant} className="kp-device-state">
      {dot && <span aria-hidden data-live={dot === 'live' || undefined} />}
      {children}
    </Badge>
  )
}

/** What a device's tab says after its name, when it is anything but ready. */
function TabState({
  device,
  stream,
  opening,
  compact,
}: {
  device: DeviceInfo
  stream: DeviceStream | undefined
  /** The pane is still opening it: booted, but not yet ready to show. */
  opening: boolean
  compact: boolean
}) {
  const { t } = useTranslation('devices')
  if (device.problems.length > 0)
    return (
      <State variant="warning" compact={compact}>
        {t('state.notReady')}
      </State>
    )
  if (device.state === 'booting' || opening) {
    return (
      <State variant="info" dot="live" compact={compact}>
        {t('state.starting')}
      </State>
    )
  }
  if (device.state === 'shutdown') {
    return (
      <State variant="neutral" compact={compact}>
        {t('state.shutdown')}
      </State>
    )
  }
  if (device.state === 'unavailable') {
    return (
      <State variant="neutral" compact={compact}>
        {t('state.unavailable')}
      </State>
    )
  }
  const ended = stream?.state === 'stopped' || stream?.state === 'error'
  if (ended && stream.drawn) {
    return (
      <State variant="warning" dot="still">
        {t('state.lost')}
      </State>
    )
  }
  if (ended) {
    return (
      <State variant="error" dot="still">
        {t('state.error')}
      </State>
    )
  }
  return null
}

/** The side panel's Mobile devices pane: the devices a session holds, one tab each. */
export function DevicesPane({ panel, maximized }: { panel: string; maximized: boolean }) {
  const { t } = useTranslation('devices')
  const sessionId = panelSession(panel)
  const devices = useDevicesStore((s) => s.devices)
  const loaded = useDevicesStore((s) => s.loaded)
  const environment = useDevicesStore((s) => s.environment)
  const error = useDevicesStore((s) => s.error)
  const opening = useDevicesStore((s) => (sessionId ? s.opening[sessionId] : undefined))
  const selectedId = useDevicesStore((s) => (sessionId ? s.selected[sessionId] : undefined))
  const held = devicesOf(devices, sessionId)
  const selected = held.find((device) => device.id === selectedId) ?? held[0] ?? null
  const stream = useDevicesStore((s) => (selected ? s.streams[selected.id] : undefined))
  const recording = useDevicesStore((s) =>
    selected && s.recording?.deviceId === selected.id ? s.recording : null,
  )

  useEffect(() => {
    void loadDevices()
  }, [])

  useEffect(() => {
    if (sessionId) seenDevices(sessionId)
  }, [sessionId])

  const running =
    !!selected &&
    selected.problems.length === 0 &&
    (selected.state === 'booted' || selected.state === 'connected')
  const live = running && stream?.state === 'live'

  let body: ReactNode
  if (!sessionId) {
    body = <Notice icon={SmartPhone01Icon} title={t('empty.noSession')} />
  } else if (!loaded) {
    body = null
  } else if (error && devices.length === 0) {
    body = (
      <Notice icon={Alert02Icon} title={t('empty.failed')} text={error}>
        <Button
          variant="secondary"
          size="sm"
          icon={<PaneIcon icon={RefreshIcon} size={14} />}
          onClick={() => void loadDevices()}
        >
          {t('actions.retry')}
        </Button>
      </Notice>
    )
  } else if (opening && !selected) {
    body = <Starting name={devices.find((device) => device.id === opening)?.name ?? null} />
  } else if (!selected) {
    body = <NoDevice sessionId={sessionId} />
  } else if (selected.problems.length > 0) {
    body = (
      <div className="kp-device-scroll">
        <DeviceSetup device={selected} environment={environment} />
      </div>
    )
  } else if (selected.state === 'booting' || opening === selected.id) {
    // The host refuses to stream a device until it has booted.
    body = <Starting name={selected.name} />
  } else if (selected.state === 'shutdown') {
    body = (
      <Notice
        icon={ShutDownIcon}
        title={t('screen.shutdown', { name: selected.name })}
        text={t('screen.shutdownHint')}
      >
        <Button
          variant="secondary"
          size="sm"
          icon={<PaneIcon icon={PlayIcon} size={14} />}
          onClick={() => void openDevice(sessionId, selected.id)}
        >
          {t('actions.boot')}
        </Button>
      </Notice>
    )
  } else if (selected.state === 'unavailable') {
    body = (
      <Notice
        icon={Unlink01Icon}
        title={t('screen.unavailable', { name: selected.name })}
        text={t('screen.unavailableHint')}
      />
    )
  } else if ((stream?.state === 'error' || stream?.state === 'stopped') && !stream.drawn) {
    body = (
      <Notice
        icon={Alert02Icon}
        title={t('screen.failed', { name: selected.name })}
        text={
          stream.error ? (
            <code className="kp-device-reason">{stream.error}</code>
          ) : (
            t('screen.error')
          )
        }
      >
        <Button
          variant="secondary"
          size="sm"
          icon={<PaneIcon icon={RefreshIcon} size={14} />}
          onClick={() => setDeviceStream(selected.id, null)}
        >
          {t('actions.retry')}
        </Button>
      </Notice>
    )
  } else {
    body = <Stage device={selected} sessionId={sessionId} />
  }

  return (
    <PaneSheet pane="devices" maximized={maximized} data-devices-panel="">
      <PaneHead
        panel={panel}
        pane="devices"
        maximized={maximized}
        tools={
          <>
            <PanelButton
              label={t('actions.screenshot')}
              disabled={!live || !sessionId}
              onClick={() => selected && sessionId && void saveScreenshot(selected, sessionId)}
            >
              <PaneIcon icon={Camera01Icon} />
            </PanelButton>
            {recording ? (
              <>
                <Elapsed since={recording.since} />
                <PanelButton label={t('actions.stopRecording')} onClick={stopRecording}>
                  <PaneIcon icon={StopIcon} />
                </PanelButton>
              </>
            ) : (
              <PanelButton
                label={t('actions.record')}
                disabled={!live || !canRecord()}
                onClick={() => selected && startRecording(selected)}
              >
                <PaneIcon icon={RecordIcon} />
              </PanelButton>
            )}
            <MoreMenu device={selected} sessionId={sessionId} running={running} />
          </>
        }
      >
        {held.length > 0 ? (
          <div role="tablist" aria-label={t('tabs')} className="kp-head__tabs">
            {held.map((device) => (
              <span
                key={device.id}
                className="kp-tab"
                data-selected={device.id === selected?.id || undefined}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={device.id === selected?.id}
                  title={`${device.name} · ${t(`kind.${device.kind}`)}`}
                  onClick={() => sessionId && selectDevice(sessionId, device.id)}
                  className="kp-tab__btn kp-device-tab"
                >
                  <PaneIcon icon={markOf(device)} size={14} className="kp-tab__icon" />
                  <span className="kp-tab__name">{device.name}</span>
                  <TabState
                    device={device}
                    stream={device.id === selected?.id ? stream : undefined}
                    opening={device.id === opening}
                    compact={device.id !== selected?.id}
                  />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span className="kp-head__title">{t('title')}</span>
        )}
        {/* Beside the tab strip, not in it, so the strip's scrolling never clips the menu. */}
        {sessionId && <AddDeviceMenu sessionId={sessionId} open={held.length} />}
      </PaneHead>
      <div className="kp-body">
        {sessionId && <DeviceRequest sessionId={sessionId} />}
        {body}
      </div>
    </PaneSheet>
  )
}

/** A state in the screen's place: an icon, a title, one line and the next step. */
function Notice({
  icon,
  media,
  title,
  text,
  children,
}: {
  icon?: IconSvgElement
  media?: ReactNode
  title: ReactNode
  text?: ReactNode
  children?: ReactNode
}) {
  return (
    <Empty className="kp-device-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {media ?? (icon && <PaneIcon icon={icon} size={20} />)}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {text && <EmptyDescription>{text}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  )
}

function Starting({ name }: { name: string | null }) {
  const { t } = useTranslation('devices')
  return (
    <Notice
      media={<PaneSpinner />}
      title={name ? t('empty.starting', { name }) : t('empty.opening')}
      text={t('empty.openingHint')}
    />
  )
}

/** How long the recording has run, as the red badge before Stop. */
function Elapsed({ since }: { since: number }) {
  const { t } = useTranslation('devices')
  const seconds = Math.max(0, Math.floor((useSeconds() - since) / 1000))
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return (
    <Badge
      variant="error"
      role="timer"
      aria-label={t('capture.recording', { time })}
      className="kp-device-state mx-0.5 tabular-nums"
    >
      <span aria-hidden data-live="" />
      {time}
    </Badge>
  )
}

/** The device on its stage: who drives it on top, the screen, and its hardware buttons under it. */
function Stage({ device, sessionId }: { device: DeviceInfo; sessionId: string }) {
  const { t } = useTranslation('devices')
  const operator = device.operator
  const agentId = useSessionsStore((s) =>
    operator?.sessionId ? (s.byId[operator.sessionId]?.agentId ?? null) : null,
  )
  const hostId = useSessionsStore((s) =>
    operator?.sessionId ? hostOfPath(s.byId[operator.sessionId]?.projectPath ?? '') : null,
  )
  return (
    <div className="kp-stage">
      <DeviceScreen
        key={device.id}
        device={device}
        sessionId={sessionId}
        driven={!!operator && !operator.user}
      />
      {operator && (
        <DrivingPill
          agent={agentId}
          hostId={hostId}
          user={operator.user}
          onTakeOver={() =>
            void window.kettu.devices.request('devices.stopAgent', {
              deviceId: device.id,
              sessionId,
            })
          }
          onHandBack={() =>
            void window.kettu.devices.request('devices.handBack', {
              deviceId: device.id,
              sessionId,
            })
          }
        />
      )}
      <div role="toolbar" aria-label={t('buttons.label')} className="kp-hw">
        {BUTTONS.map((group, index) => {
          const shown = group.filter((entry) => entry.platforms.includes(device.platform))
          return (
            shown.length > 0 && (
              <span key={index} className="contents">
                {index > 0 && <span aria-hidden className="kp-hw__gap" />}
                {shown.map(({ button, icon }) => (
                  <PanelButton
                    key={button}
                    label={t(`buttons.${button}`)}
                    onClick={() =>
                      void window.kettu.devices
                        .request('devices.input', {
                          deviceId: device.id,
                          sessionId,
                          input: { type: 'button', button },
                        })
                        .catch(() => undefined)
                    }
                  >
                    <PaneIcon icon={icon} />
                  </PanelButton>
                ))}
              </span>
            )
          )
        })}
      </div>
    </div>
  )
}

/** The devices a session can add, by system: every one of this host it does not hold yet. */
function useAddable(sessionId: string): { title: string; devices: DeviceInfo[] }[] {
  const devices = useDevicesStore((s) => s.devices)
  const others = devices.filter((device) => device.sessionId !== sessionId)
  return [
    { title: 'iOS', devices: others.filter((device) => device.platform === 'ios') },
    { title: 'Android', devices: others.filter((device) => device.platform === 'android') },
  ].filter((group) => group.devices.length > 0)
}

/** What picking a device does, and the state its row ends with. */
function rowOf(device: DeviceInfo): {
  state: 'shutdown' | 'unavailable' | 'plugIn' | 'notAllowed' | 'elsewhere' | null
  act: (sessionId: string) => Promise<void>
} {
  if (device.sessionId !== null) {
    return { state: 'elsewhere', act: (sessionId) => moveDevice(sessionId, device.id) }
  }
  const state = device.problems.includes('usb-required')
    ? 'plugIn'
    : device.problems.includes('usb-debugging-unauthorized')
      ? 'notAllowed'
      : device.state === 'shutdown'
        ? 'shutdown'
        : device.state === 'unavailable'
          ? 'unavailable'
          : null
  return { state, act: (sessionId) => openDevice(sessionId, device.id) }
}

const ROW_VARIANT = {
  shutdown: 'neutral',
  unavailable: 'neutral',
  plugIn: 'warning',
  notAllowed: 'warning',
  elsewhere: 'info',
} as const

/** A device's row in the add menu and in the empty pane: its mark, name and state. */
function DeviceRow({ device }: { device: DeviceInfo }) {
  const { t } = useTranslation('devices')
  const { state } = rowOf(device)
  return (
    <>
      <PaneIcon icon={markOf(device)} size={16} />
      <span className="min-w-0 flex-1 truncate" title={device.name}>
        {device.name}
      </span>
      {state && <State variant={ROW_VARIANT[state]}>{t(`row.${state}`)}</State>}
      {state === 'elsewhere' && <span className="kp-device-move">{t('row.move')}</span>}
    </>
  )
}

function AddDeviceMenu({ sessionId, open }: { sessionId: string; open: number }) {
  const { t } = useTranslation('devices')
  const groups = useAddable(sessionId)
  const full = open >= SESSION_DEVICE_LIMIT
  return (
    <DropdownMenu onOpenChange={(shown) => shown && void loadDevices()}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t('actions.addDevice')}
                  className="kp-tool app-region-no-drag"
                />
              }
            />
          }
        >
          <PaneIcon icon={PlusSignIcon} />
        </TooltipTrigger>
        <TooltipContent>{t('actions.addDevice')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {t('add.title', { open, limit: SESSION_DEVICE_LIMIT })}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        {groups.length === 0 && (
          <div className="px-2 py-1.5 text-hint text-secondary">{t('picker.none')}</div>
        )}
        {groups.map((group, index) => (
          <DropdownMenuGroup key={group.title}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{group.title}</DropdownMenuLabel>
            {group.devices.map((device) => (
              <DropdownMenuItem
                key={device.id}
                disabled={full}
                onClick={() => void rowOf(device).act(sessionId)}
              >
                <DeviceRow device={device} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MoreMenu({
  device,
  sessionId,
  running,
}: {
  device: DeviceInfo | null
  sessionId: string | null
  running: boolean
}) {
  const { t } = useTranslation('devices')
  // Undefined until the host answers; null where it cannot tell or set it.
  const [appearance, setAppearance] = useState<DeviceAppearance | null | undefined>(undefined)
  const usable = device !== null && sessionId !== null
  const virtual = device !== null && device.kind !== 'physical'

  const read = (): void => {
    if (!usable || !running) return setAppearance(null)
    setAppearance(undefined)
    window.kettu.devices
      .request('devices.appearance', { deviceId: device.id, sessionId })
      .then((result) => setAppearance(result.appearance))
      .catch(() => setAppearance(null))
  }
  const choose = (next: DeviceAppearance): void => {
    if (!usable) return
    const before = appearance
    setAppearance(next)
    window.kettu.devices
      .request('devices.setAppearance', { deviceId: device.id, sessionId, appearance: next })
      .catch((error: unknown) => {
        setAppearance(before)
        toast(errorMessage(error))
      })
  }

  return (
    <DropdownMenu onOpenChange={(shown) => shown && read()}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t('actions.more')}
                  disabled={!usable}
                  className="kp-tool app-region-no-drag"
                />
              }
            />
          }
        >
          <PaneIcon icon={MoreHorizontalIcon} />
        </TooltipTrigger>
        <TooltipContent>{t('actions.more')}</TooltipContent>
      </Tooltip>
      {usable && (
        <DropdownMenuContent align="end" className="min-w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('more.appearance')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={appearance ?? ''}
              onValueChange={(value) => choose(value as DeviceAppearance)}
            >
              <DropdownMenuRadioItem value="light" disabled={!appearance} closeOnClick={false}>
                <PaneIcon icon={Sun03Icon} size={16} />
                {t('more.light')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark" disabled={!appearance} closeOnClick={false}>
                <PaneIcon icon={Moon02Icon} size={16} />
                {t('more.dark')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="h-auto items-start py-1.5"
            onClick={() => void closeDevice(sessionId, device.id)}
          >
            <PaneIcon icon={Unlink01Icon} size={16} className="mt-0.5" />
            <span className="flex min-w-0 flex-col">
              <span>{t('more.disconnect')}</span>
              <span className={cn('text-small text-tertiary')}>
                {device.bootedByHost
                  ? t('more.disconnectShutsDown')
                  : virtual
                    ? t('more.disconnectStaysOn')
                    : t('more.disconnectStaysConnected')}
              </span>
            </span>
          </DropdownMenuItem>
          {virtual && (
            <DropdownMenuItem
              variant="destructive"
              disabled={device.state === 'shutdown'}
              onClick={() => void shutDownDevice(sessionId, device.id)}
            >
              <PaneIcon icon={ShutDownIcon} size={16} />
              {t('more.shutDown')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  )
}

/** With nothing open yet, the pane lists what can be opened, as the add menu does. */
function NoDevice({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('devices')
  const environment = useDevicesStore((s) => s.environment)
  const groups = useAddable(sessionId)
  const list = groups.length > 0 && (
    <div className="kp-devlist">
      {groups.map((group) => (
        <section key={group.title}>
          <h3 className="kp-devlist__head">{group.title}</h3>
          {group.devices.map((device) => (
            <button
              key={device.id}
              type="button"
              onClick={() => void rowOf(device).act(sessionId)}
              className="kp-devrow"
            >
              <DeviceRow device={device} />
            </button>
          ))}
        </section>
      ))}
    </div>
  )
  // A Mac without Xcode, or a computer with neither system's tools, is set up first.
  const setUp =
    environment !== null &&
    !environment.ios &&
    (environment.platform === 'darwin' || !environment.android)
  if (setUp) {
    return (
      <div className="kp-device-scroll">
        <HostSetup environment={environment} />
        {list}
      </div>
    )
  }
  if (!list) {
    return <Notice icon={SmartPhone01Icon} title={t('picker.none')} text={t('picker.noneHint')} />
  }
  return (
    <div className="kp-device-center">
      <Notice icon={SmartPhone01Icon} title={t('picker.title')} text={t('picker.hint')} />
      {list}
    </div>
  )
}

export default DevicesPane
