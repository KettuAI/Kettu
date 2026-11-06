import { useEffect } from 'react'
import {
  ChevronLeftIcon,
  CircleIcon,
  HomeIcon,
  LayersIcon,
  LockIcon,
  Maximize2Icon,
  Minimize2Icon,
  PlusIcon,
  PowerIcon,
  RotateCwIcon,
  SmartphoneIcon,
  TabletSmartphoneIcon,
  Volume1Icon,
  Volume2Icon,
  XIcon,
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { DeviceButton, DeviceInfo, DeviceProblem } from '@shared/device-host'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { DrivingPill } from '@renderer/features/browser/driving-bar'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { SHEET } from '@renderer/features/shell/sheet'
import { CornerControlsSpace } from '@renderer/features/shell/top-bar'
import { hasBand } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
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
import { panelSession, toggleSidePane, useViewStore } from '@renderer/stores/view'
import { DeviceScreen } from './device-screen'

const BUTTONS: {
  button: DeviceButton
  platforms: DeviceInfo['platform'][]
  icon: typeof HomeIcon
}[] = [
  { button: 'back', platforms: ['android'], icon: ChevronLeftIcon },
  { button: 'home', platforms: ['ios', 'android'], icon: HomeIcon },
  { button: 'recents', platforms: ['ios', 'android'], icon: LayersIcon },
  { button: 'lock', platforms: ['ios', 'android'], icon: LockIcon },
  { button: 'volumeDown', platforms: ['ios', 'android'], icon: Volume1Icon },
  { button: 'volumeUp', platforms: ['ios', 'android'], icon: Volume2Icon },
  { button: 'rotate', platforms: ['ios', 'android'], icon: RotateCwIcon },
]

/** The side panel's fourth pane: the mobile devices a session holds, one tab each. */
export function DevicesPane({ panel, maximized }: { panel: string; maximized: boolean }) {
  const { t } = useTranslation('devices')
  const sessionId = panelSession(panel)
  const devices = useDevicesStore((s) => s.devices)
  const loaded = useDevicesStore((s) => s.loaded)
  const environment = useDevicesStore((s) => s.environment)
  const error = useDevicesStore((s) => s.error)
  const opening = useDevicesStore((s) => (sessionId ? s.opening[sessionId] : undefined))
  const selectedId = useDevicesStore((s) => (sessionId ? s.selected[sessionId] : undefined))
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized && !hasBand
  const held = devicesOf(devices, sessionId)
  const selected = held.find((device) => device.id === selectedId) ?? held[0] ?? null

  useEffect(() => {
    void loadDevices()
  }, [])

  useEffect(() => {
    if (sessionId) seenDevices(sessionId)
  }, [sessionId])

  return (
    <div className={cn('flex h-full min-w-0 flex-col', SHEET)} data-devices-panel="">
      <div
        className={cn(
          'app-region-drag flex h-11 shrink-0 items-center gap-1 pr-2 pl-2.5 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]',
          cornered && 'pl-(--corner-inset)',
        )}
      >
        {cornered && <CornerControlsSpace className="mr-1" />}
        <div
          role="tablist"
          aria-label={t('tabs')}
          className="app-region-no-drag flex min-w-0 items-center gap-1"
        >
          {held.map((device) => (
            <button
              key={device.id}
              type="button"
              role="tab"
              aria-selected={device.id === selected?.id}
              onClick={() => sessionId && selectDevice(sessionId, device.id)}
              className={cn(
                'flex h-7 max-w-48 min-w-0 items-center gap-2 rounded-xl px-2.5 text-hint text-secondary outline-none focus-ring',
                device.id === selected?.id && 'bg-raised text-primary shadow-segment',
              )}
            >
              <DeviceIcon device={device} />
              <span className="min-w-0 truncate">{device.name}</span>
            </button>
          ))}
          {sessionId && <AddDeviceMenu sessionId={sessionId} />}
        </div>
        <span className="min-w-2 flex-1" />
        <div className="app-region-no-drag flex items-center gap-0.5">
          {selected && sessionId && (
            <PanelButton
              label={t('actions.closeDevice')}
              size="icon-sm"
              onClick={() => void closeDevice(sessionId, selected.id)}
            >
              <PowerIcon className="size-3.75" />
            </PanelButton>
          )}
          <PanelButton
            label={maximized ? t('actions.restore') : t('actions.maximize')}
            size="icon-sm"
            onClick={() => useViewStore.setState({ sidePaneMaximized: !maximized })}
          >
            {maximized ? (
              <Minimize2Icon className="size-3.75" />
            ) : (
              <Maximize2Icon className="size-3.75" />
            )}
          </PanelButton>
          <PanelButton
            label={t('actions.close')}
            size="icon-sm"
            onClick={() => toggleSidePane(panel, 'devices', false)}
          >
            <XIcon className="size-3.75" />
          </PanelButton>
        </div>
      </div>
      {selected && <OperatorBar device={selected} />}
      {error && (
        <div role="alert" className="shrink-0 px-4 py-2 text-hint text-danger">
          {error}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col bg-background">
        {!sessionId ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>{t('empty.noSession')}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : !loaded ? null : environment && !environment.ios && !environment.android ? (
          <NoTools problems={environment.problems} />
        ) : opening ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>{t('empty.opening')}</EmptyTitle>
              <EmptyDescription>{t('empty.openingHint')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : selected ? (
          <>
            {selected.problems.length > 0 && <Checklist device={selected} />}
            {selected.state === 'shutdown' ? (
              <Empty className="flex-1">
                <EmptyHeader>
                  <EmptyTitle>{t('screen.shutdown')}</EmptyTitle>
                </EmptyHeader>
                <Button onClick={() => void openDevice(sessionId, selected.id)}>
                  {t('actions.boot')}
                </Button>
              </Empty>
            ) : selected.state === 'booting' ? (
              // The host refuses to stream a device until it has booted.
              <Empty className="flex-1">
                <EmptyHeader>
                  <EmptyTitle>{t('empty.opening')}</EmptyTitle>
                  <EmptyDescription>{t('empty.openingHint')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <DeviceScreen key={selected.id} device={selected} />
            )}
            <ButtonRow device={selected} />
          </>
        ) : (
          <Picker sessionId={sessionId} />
        )}
      </div>
    </div>
  )
}

function DeviceIcon({ device, className }: { device: DeviceInfo; className?: string }) {
  const Icon = device.kind === 'physical' ? SmartphoneIcon : TabletSmartphoneIcon
  return <Icon aria-hidden className={cn('size-3.5 shrink-0 text-icon', className)} />
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

function AddDeviceMenu({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('devices')
  const { ios, android } = useAvailable(sessionId)
  return (
    <DropdownMenu onOpenChange={(open) => open && void loadDevices()}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={t('actions.addDevice')}
            className="text-secondary"
          />
        }
      >
        <PlusIcon className="size-3.75" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72">
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
    <DropdownMenuItem onClick={() => void openDevice(sessionId, device.id)}>
      <DeviceIcon device={device} />
      <span className="min-w-0 flex-1 truncate">{device.name}</span>
      <span className="shrink-0 text-small text-tertiary">{deviceDetail(t, device)}</span>
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
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SmartphoneIcon />
          </EmptyMedia>
          <EmptyTitle>{t('picker.none')}</EmptyTitle>
          <EmptyDescription>{t('picker.noneHint')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <h2 className="mb-1 text-body font-medium text-primary">{t('picker.title')}</h2>
      <p className="mb-4 text-hint text-secondary">{t('picker.hint')}</p>
      {groups.map((group) => (
        <section key={group.title} className="mb-4">
          <h3 className="mb-1.5 text-small font-medium text-tertiary">{group.title}</h3>
          <ul className="flex flex-col gap-0.5">
            {group.devices.map((device) => (
              <li key={device.id}>
                <button
                  type="button"
                  onClick={() => void openDevice(sessionId, device.id)}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-hint text-primary outline-none hover:bg-subtle focus-ring"
                >
                  <DeviceIcon device={device} />
                  <span className="min-w-0 flex-1 truncate">{device.name}</span>
                  <span className="shrink-0 text-small text-tertiary">
                    {deviceDetail(t, device)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function NoTools({ problems }: { problems: DeviceProblem[] }) {
  const { t } = useTranslation('devices')
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SmartphoneIcon />
        </EmptyMedia>
        <EmptyTitle>{t('empty.noTools')}</EmptyTitle>
        <EmptyDescription>
          {problems.map((problem) => t(`problem.${problem}`)).join(' ')}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

/** What the device still needs, one step at a time. */
function Checklist({ device }: { device: DeviceInfo }) {
  const { t } = useTranslation('devices')
  return (
    <div className="shrink-0 border-b border-border-subtle px-4 py-3">
      <p className="mb-1.5 text-hint font-medium text-primary">{t('checklist.title')}</p>
      <ul className="flex flex-col gap-1">
        {device.problems.map((problem) => (
          <li key={problem} className="flex items-start gap-2 text-hint text-secondary">
            <CircleIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-icon" />
            {t(`problem.${problem}`)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function OperatorBar({ device }: { device: DeviceInfo }) {
  const operator = device.operator
  const agentId = useSessionsStore((s) =>
    operator?.sessionId ? (s.byId[operator.sessionId]?.agentId ?? null) : null,
  )
  if (!operator) return null
  return (
    <div className="flex h-10 shrink-0 items-center justify-end px-2.5 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]">
      <DrivingPill
        agent={agentId}
        user={operator.user}
        onTakeOver={() =>
          void window.kettu.devices.request('devices.stopAgent', { deviceId: device.id })
        }
        onHandBack={() =>
          void window.kettu.devices.request('devices.handBack', { deviceId: device.id })
        }
      />
    </div>
  )
}

function ButtonRow({ device }: { device: DeviceInfo }) {
  const { t } = useTranslation('devices')
  if (device.state === 'shutdown') return null
  return (
    <div
      role="toolbar"
      aria-label={t('buttons.label')}
      className="flex h-11 shrink-0 items-center justify-center gap-0.5 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]"
    >
      {BUTTONS.filter((entry) => entry.platforms.includes(device.platform)).map(
        ({ button, icon: Icon }) => (
          <PanelButton
            key={button}
            label={t(`buttons.${button}`)}
            size="icon-sm"
            onClick={() =>
              void window.kettu.devices
                .request('devices.input', {
                  deviceId: device.id,
                  input: { type: 'button', button },
                })
                .catch(() => undefined)
            }
          >
            <Icon className="size-3.75" />
          </PanelButton>
        ),
      )}
    </div>
  )
}

export default DevicesPane
