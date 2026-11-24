import { useEffect, useState, type ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  Alert02Icon,
  ArrowTurnBackwardIcon,
  Camera01Icon,
  DashboardSquare01Icon,
  Home01Icon,
  Moon02Icon,
  MoreHorizontalIcon,
  PlayIcon,
  RecordIcon,
  RefreshIcon,
  RotateClockwiseIcon,
  ShutDownIcon,
  SmartPhone01Icon,
  SquareLock02Icon,
  StopIcon,
  Sun03Icon,
  Unlink01Icon,
  VolumeHighIcon,
  VolumeLowIcon,
} from '@hugeicons/core-free-icons'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { DeviceAppearance, DeviceButton, DeviceInfo } from '@shared/device-host'
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
import { PillDock } from '@renderer/components/control/pill-dock'
import { SurfacePill } from '@renderer/components/control/surface-pill'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import {
  PaneBody,
  PaneContext,
  PaneIcon,
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
  controlDevice,
  devicesOf,
  loadDevices,
  openDevice,
  seenDevices,
  setDeviceStream,
  shutDownDevice,
  useDevicesStore,
} from '@renderer/stores/devices'
import { useSessionsStore } from '@renderer/stores/sessions'
import { panelSession } from '@renderer/stores/view'
import { canRecord, saveScreenshot, startRecording, stopRecording } from './device-capture'
import { DeviceRequest } from './device-request'
import { DeviceScreen } from './device-screen'
import { rowOf, useAddable } from './device-marks'
import { DeviceRow } from './device-row'
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

/**
 * What a device's tab shows in the side panel: the context bar with the device and its tools,
 * and its screen. With no device selected it lists the ones the session can open.
 */
export function DevicesPane({ panel }: { panel: string }) {
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
    <PaneBody data-devices-panel="">
      {selected && (
        <PaneContext
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
                  <PanelButton
                    label={t('actions.stopRecording')}
                    className="kp-tool--stop"
                    onClick={stopRecording}
                  >
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
          <span className="kp-ctx__place" title={selected.name}>
            <b>{selected.name}</b>
            {selected.osVersion && (
              <span>
                {selected.platform === 'ios' ? 'iOS' : 'Android'} {selected.osVersion}
              </span>
            )}
          </span>
        </PaneContext>
      )}
      <div className="kp-body">
        {sessionId && <DeviceRequest sessionId={sessionId} />}
        {body}
      </div>
    </PaneBody>
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

/**
 * The device on its stage: the screen, and its hardware buttons under it; while a turn uses it,
 * the pill over the buttons says who has it.
 */
function Stage({ device, sessionId }: { device: DeviceInfo; sessionId: string }) {
  const { t } = useTranslation('devices')
  const { t: tc } = useTranslation('control')
  const operator = device.operator
  const control = operator?.control ?? null
  const agentId = useSessionsStore((s) =>
    operator?.sessionId ? (s.byId[operator.sessionId]?.agentId ?? null) : null,
  )
  const hostId = useSessionsStore((s) =>
    operator?.sessionId ? hostOfPath(s.byId[operator.sessionId]?.projectPath ?? '') : null,
  )
  const agent = useControlAgent(agentId, hostId)
  const agentName = agent?.name ?? operator?.agentName ?? tc('agent')
  const [nudge, setNudge] = useState(0)
  const held = () => setNudge((n) => n + 1)
  const takeOver = () => controlDevice('devices.takeOver', device.id, sessionId)
  return (
    <div className="kp-stage">
      <DeviceScreen
        key={device.id}
        device={device}
        sessionId={sessionId}
        control={control}
        agentName={agentName}
        onHeld={held}
        onTakeOver={takeOver}
      />
      <PillDock kind="device" className="kp-stage__pill">
        <AnimatePresence>
          {control && (
            <SurfacePill
              key="pill"
              control={control}
              agent={agent}
              agentName={agentName}
              scope={tc('scope.device')}
              nudge={nudge}
              onTakeOver={takeOver}
              onHandBack={() => controlDevice('devices.handBack', device.id, sessionId)}
              // No step is asked on a device; Done hands it back all the same.
              onDone={() => controlDevice('devices.handBack', device.id, sessionId)}
            />
          )}
        </AnimatePresence>
      </PillDock>
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
                      control?.kind === 'agent'
                        ? held()
                        : void window.kettu.devices
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
