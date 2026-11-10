import { useEffect, type ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  ArrowTurnBackwardIcon,
  CircleIcon,
  DashboardSquare01Icon,
  Home01Icon,
  PlusSignIcon,
  RotateClockwiseIcon,
  ShutDownIcon,
  SmartPhone01Icon,
  SquareLock02Icon,
  Tablet01Icon,
  VolumeHighIcon,
  VolumeLowIcon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { DeviceButton, DeviceInfo, DeviceProblem } from '@shared/device-host'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { SystemLogo } from '@renderer/components/system-logo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DrivingPill } from '@renderer/features/browser/driving-bar'
import {
  PaneEmpty,
  PaneHead,
  PaneIcon,
  PaneSheet,
  PaneSpinner,
  PanelButton,
} from '@renderer/features/shell/panel-button'
import { hostOfPath } from '@renderer/lib/host-paths'
import {
  closeDevice,
  devicesOf,
  loadDevices,
  openDevice,
  seenDevices,
  selectDevice,
  useDevicesStore,
} from '@renderer/stores/devices'
import { useSessionsStore } from '@renderer/stores/sessions'
import { panelSession } from '@renderer/stores/view'
import { DeviceScreen } from './device-screen'

// The hardware buttons in groups: navigation, volume, then turning the device.
const BUTTONS: {
  button: DeviceButton
  platforms: DeviceInfo['platform'][]
  icon: IconSvgElement
}[][] = [
  [
    { button: 'back', platforms: ['android'], icon: ArrowTurnBackwardIcon },
    { button: 'home', platforms: ['ios', 'android'], icon: Home01Icon },
    { button: 'recents', platforms: ['ios', 'android'], icon: DashboardSquare01Icon },
    { button: 'lock', platforms: ['ios', 'android'], icon: SquareLock02Icon },
  ],
  [
    { button: 'volumeDown', platforms: ['ios', 'android'], icon: VolumeLowIcon },
    { button: 'volumeUp', platforms: ['ios', 'android'], icon: VolumeHighIcon },
  ],
  [{ button: 'rotate', platforms: ['ios', 'android'], icon: RotateClockwiseIcon }],
]

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

  useEffect(() => {
    void loadDevices()
  }, [])

  useEffect(() => {
    if (sessionId) seenDevices(sessionId)
  }, [sessionId])

  let body: ReactNode
  if (!sessionId) {
    body = (
      <PaneEmpty
        icon={<PaneIcon icon={SmartPhone01Icon} size={20} />}
        title={t('empty.noSession')}
      />
    )
  } else if (!loaded) {
    body = null
  } else if (environment && !environment.ios && !environment.android) {
    body = <NoTools problems={environment.problems} />
  } else if (opening) {
    body = <Starting />
  } else if (selected) {
    body = (
      <>
        {selected.problems.length > 0 && <Checklist device={selected} />}
        {selected.state === 'shutdown' ? (
          <PaneEmpty icon={<DeviceLogo device={selected} size={20} />} title={t('screen.shutdown')}>
            <button
              type="button"
              className="kp-btn"
              onClick={() => void openDevice(sessionId, selected.id)}
            >
              {t('actions.boot')}
            </button>
          </PaneEmpty>
        ) : selected.state === 'booting' ? (
          // The host refuses to stream a device until it has booted.
          <Starting />
        ) : (
          <Stage device={selected} />
        )}
      </>
    )
  } else {
    body = <Picker sessionId={sessionId} />
  }

  return (
    <PaneSheet pane="devices" maximized={maximized} data-devices-panel="">
      <PaneHead
        panel={panel}
        pane="devices"
        maximized={maximized}
        tools={
          <PanelButton
            label={t('actions.closeDevice')}
            disabled={!selected || !sessionId}
            onClick={() => selected && sessionId && void closeDevice(sessionId, selected.id)}
          >
            <PaneIcon icon={ShutDownIcon} />
          </PanelButton>
        }
      >
        {held.length > 0 && (
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
                  className="kp-tab__btn"
                  style={{ paddingRight: 8 }}
                >
                  <DeviceLogo device={device} />
                  <span className="kp-tab__name">{device.name}</span>
                </button>
              </span>
            ))}
          </div>
        )}
        {/* Beside the tab strip, not in it, so the strip's scrolling never clips the menu. */}
        {sessionId && <AddDeviceMenu sessionId={sessionId} />}
      </PaneHead>
      <div className="kp-body">
        {error && (
          <p role="alert" className="kp-alert">
            {error}
          </p>
        )}
        {body}
      </div>
    </PaneSheet>
  )
}

function Starting() {
  const { t } = useTranslation('devices')
  return (
    <PaneEmpty icon={<PaneSpinner />} title={t('empty.opening')} text={t('empty.openingHint')} />
  )
}

/** The system a device runs, by its logo. */
function DeviceLogo({ device, size = 14 }: { device: DeviceInfo; size?: number }) {
  return (
    <span className="kp-tab__icon" style={{ display: 'grid', width: size, height: size }}>
      <SystemLogo name={device.platform === 'ios' ? 'apple' : 'android'} className="size-full" />
    </span>
  )
}

/** The device on its stage: who drives it on top, the screen, and its hardware buttons under it. */
function Stage({ device }: { device: DeviceInfo }) {
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
      <DeviceScreen key={device.id} device={device} driven={!!operator && !operator.user} />
      {operator && (
        <DrivingPill
          agent={agentId}
          hostId={hostId}
          user={operator.user}
          onTakeOver={() =>
            void window.kettu.devices.request('devices.stopAgent', { deviceId: device.id })
          }
          onHandBack={() =>
            void window.kettu.devices.request('devices.handBack', { deviceId: device.id })
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

function useAvailable(sessionId: string): { ios: DeviceInfo[]; android: DeviceInfo[] } {
  const devices = useDevicesStore((s) => s.devices)
  const free = devices.filter(
    (device) => device.sessionId === null || device.sessionId === sessionId,
  )
  return {
    ios: free.filter((device) => device.platform === 'ios'),
    android: free.filter((device) => device.platform === 'android'),
  }
}

function deviceDetail(t: TFunction<'devices'>, device: DeviceInfo): string {
  const kind = t(`kind.${device.kind}`)
  const parts = [kind, device.osVersion].filter(Boolean)
  if (device.state === 'shutdown') parts.push(t('state.shutdown'))
  if (device.state === 'unavailable') parts.push(t('state.unavailable'))
  if (device.connection === 'network') parts.push(t('connection.network'))
  return parts.join(' · ')
}

/** A device's form, a phone or a tablet, as its model names it. */
function formOf(device: DeviceInfo): IconSvgElement {
  return /ipad|tablet|tab\b/i.test(`${device.name} ${device.model ?? ''}`)
    ? Tablet01Icon
    : SmartPhone01Icon
}

function AddDeviceMenu({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('devices')
  const { ios, android } = useAvailable(sessionId)
  return (
    <DropdownMenu onOpenChange={(open) => open && void loadDevices()}>
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
      <DropdownMenuContent align="start" className="w-65">
        {ios.length === 0 && android.length === 0 && (
          <div className="px-2 py-1.5 text-hint text-secondary">{t('picker.none')}</div>
        )}
        {ios.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>iOS</DropdownMenuLabel>
            {ios.map((device) => (
              <DeviceItem key={device.id} sessionId={sessionId} device={device} />
            ))}
          </DropdownMenuGroup>
        )}
        {ios.length > 0 && android.length > 0 && <DropdownMenuSeparator />}
        {android.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Android</DropdownMenuLabel>
            {android.map((device) => (
              <DeviceItem key={device.id} sessionId={sessionId} device={device} />
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DeviceItem({ sessionId, device }: { sessionId: string; device: DeviceInfo }) {
  const { t } = useTranslation('devices')
  return (
    <DropdownMenuItem
      className="h-auto py-1.5"
      onClick={() => void openDevice(sessionId, device.id)}
    >
      <PaneIcon icon={formOf(device)} size={16} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{device.name}</span>
        <span className="truncate text-small text-tertiary">{deviceDetail(t, device)}</span>
      </span>
    </DropdownMenuItem>
  )
}

/** With nothing open yet, the pane lists what can be opened, as the add menu does. */
function Picker({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('devices')
  const { ios, android } = useAvailable(sessionId)
  const groups = [
    { title: 'iOS', devices: ios },
    { title: 'Android', devices: android },
  ].filter((group) => group.devices.length > 0)
  if (groups.length === 0) {
    return (
      <PaneEmpty
        icon={<PaneIcon icon={SmartPhone01Icon} size={20} />}
        title={t('picker.none')}
        text={t('picker.noneHint')}
      />
    )
  }
  return (
    <PaneEmpty
      icon={<PaneIcon icon={SmartPhone01Icon} size={20} />}
      title={t('picker.title')}
      text={t('picker.hint')}
    >
      <div className="kp-devlist">
        {groups.map((group) => (
          <section key={group.title}>
            <h3 className="kp-devlist__head">{group.title}</h3>
            {group.devices.map((device) => (
              <button
                key={device.id}
                type="button"
                onClick={() => void openDevice(sessionId, device.id)}
                className="kp-devrow"
              >
                <PaneIcon icon={formOf(device)} size={16} />
                <span className="kp-devrow__text">
                  <span className="kp-devrow__name">{device.name}</span>
                  <span className="kp-devrow__detail">{deviceDetail(t, device)}</span>
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </PaneEmpty>
  )
}

function NoTools({ problems }: { problems: DeviceProblem[] }) {
  const { t } = useTranslation('devices')
  return (
    <PaneEmpty
      icon={<PaneIcon icon={SmartPhone01Icon} size={20} />}
      title={t('empty.noTools')}
      text={problems.map((problem) => t(`problem.${problem}`)).join(' ')}
    />
  )
}

/** What the device still needs, one step at a time. */
function Checklist({ device }: { device: DeviceInfo }) {
  const { t } = useTranslation('devices')
  return (
    <div className="kp-checklist">
      <b>{t('checklist.title')}</b>
      <ul>
        {device.problems.map((problem) => (
          <li key={problem}>
            <PaneIcon icon={CircleIcon} size={12} />
            {t(`problem.${problem}`)}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default DevicesPane
