import type { IconSvgElement } from '@hugeicons/react'
import { ComputerPhoneSyncIcon, SmartPhone01Icon, Tablet01Icon } from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import type { DeviceInfo } from '@shared/device-host'
import {
  moveDevice,
  openDevice,
  useDevicesStore,
  type DeviceStream,
} from '@renderer/stores/devices'

// What a device's tab and its rows in the add lists read: its mark, its state and how picking it
// opens it. Kept apart from the pane, which loads only when it first shows.

/** A device's mark: one for simulators and emulators, the device's form for a physical one. */
export function markOf(device: DeviceInfo): IconSvgElement {
  if (device.kind !== 'physical') return ComputerPhoneSyncIcon
  return /ipad|tablet|tab\b/i.test(`${device.name} ${device.model ?? ''}`)
    ? Tablet01Icon
    : SmartPhone01Icon
}

export interface TabStatus {
  variant: 'neutral' | 'info' | 'warning' | 'error'
  dot?: 'still' | 'live'
  label: string
}

/** What a device's tab says after its name, when it is anything but ready. */
export function statusOf(
  t: TFunction<'devices'>,
  device: DeviceInfo,
  stream: DeviceStream | undefined,
  /** The pane is still opening it: booted, but not yet ready to show. */
  opening: boolean,
): TabStatus | null {
  if (device.problems.length > 0) return { variant: 'warning', label: t('state.notReady') }
  if (device.state === 'booting' || opening) {
    return { variant: 'info', dot: 'live', label: t('state.starting') }
  }
  if (device.state === 'shutdown') return { variant: 'neutral', label: t('state.shutdown') }
  if (device.state === 'unavailable') return { variant: 'neutral', label: t('state.unavailable') }
  if (stream?.state !== 'stopped' && stream?.state !== 'error') return null
  return stream.drawn
    ? { variant: 'warning', dot: 'still', label: t('state.lost') }
    : { variant: 'error', dot: 'still', label: t('state.error') }
}

export function useAddable(sessionId: string): { title: string; devices: DeviceInfo[] }[] {
  const devices = useDevicesStore((s) => s.devices)
  const others = devices.filter((device) => device.sessionId !== sessionId)
  return [
    { title: 'iOS', devices: others.filter((device) => device.platform === 'ios') },
    { title: 'Android', devices: others.filter((device) => device.platform === 'android') },
  ].filter((group) => group.devices.length > 0)
}

/** What picking a device does, and the state its row ends with. */
export function rowOf(device: DeviceInfo): {
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
