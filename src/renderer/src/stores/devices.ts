import { create } from 'zustand'
import type { DeviceEnvironment, DeviceInfo } from '@shared/device-host'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useViewStore } from '@renderer/stores/view'

interface DevicesStore {
  environment: DeviceEnvironment | null
  /** Every device of this computer, as the device host last listed them. */
  devices: DeviceInfo[]
  loaded: boolean
  error: string | null
  /** The device each session's pane shows. */
  selected: Record<string, string>
  /** Sessions whose agent opened a device while the panel showed another pane. */
  unseen: Record<string, true>
  /** A device the pane is opening, booting it first when it is off. */
  opening: Record<string, string>
}

export const useDevicesStore = create<DevicesStore>()(() => ({
  environment: null,
  devices: [],
  loaded: false,
  error: null,
  selected: {},
  unseen: {},
  opening: {},
}))

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Lists the devices and what this computer can run, once the pane or the toggle needs them. */
export async function loadDevices(): Promise<void> {
  try {
    const [environment, devices] = await Promise.all([
      window.kettu.devices.request('devices.environment', {}),
      window.kettu.devices.request('devices.list', {}),
    ])
    useDevicesStore.setState({ environment, devices, loaded: true, error: null })
  } catch (error) {
    useDevicesStore.setState({ loaded: true, error: message(error) })
  }
}

/** The devices a session holds, in the order the host lists them. */
export function devicesOf(devices: DeviceInfo[], sessionId: string | null): DeviceInfo[] {
  return sessionId ? devices.filter((device) => device.sessionId === sessionId) : []
}

export async function openDevice(sessionId: string, deviceId: string): Promise<void> {
  useDevicesStore.setState((s) => ({
    opening: { ...s.opening, [sessionId]: deviceId },
    error: null,
  }))
  try {
    const info = await window.kettu.devices.request('devices.open', { deviceId, sessionId })
    useDevicesStore.setState((s) => ({ selected: { ...s.selected, [sessionId]: info.id } }))
  } catch (error) {
    useDevicesStore.setState({ error: message(error) })
  } finally {
    useDevicesStore.setState((s) => {
      const opening = { ...s.opening }
      delete opening[sessionId]
      return { opening }
    })
  }
}

export async function closeDevice(
  sessionId: string,
  deviceId: string,
  shutdown = false,
): Promise<void> {
  try {
    await window.kettu.devices.request('devices.close', { deviceId, sessionId, shutdown })
  } catch (error) {
    useDevicesStore.setState({ error: message(error) })
  }
}

export function selectDevice(sessionId: string, deviceId: string): void {
  useDevicesStore.setState((s) => ({ selected: { ...s.selected, [sessionId]: deviceId } }))
}

export function seenDevices(sessionId: string): void {
  useDevicesStore.setState((s) => {
    if (!s.unseen[sessionId]) return s
    const unseen = { ...s.unseen }
    delete unseen[sessionId]
    return { unseen }
  })
}

/**
 * Follows the device list the host sends. A device an agent opens shows in its session's panel
 * when that panel shows nothing else; one showing another pane keeps it, and the toggle gets a dot.
 */
export function initDevices(): void {
  window.kettu.devices.onEvent((event) => {
    if (event.type === 'devices.changed') {
      useDevicesStore.setState({ devices: event.devices, loaded: true })
    }
  })
  // From main, so a window that never opened the pane still hears it.
  window.kettu.devices.onOpened(({ sessionId, deviceId }) => {
    if (!useSessionsStore.getState().byId[sessionId]) return
    useDevicesStore.setState((s) => ({ selected: { ...s.selected, [sessionId]: deviceId } }))
    void loadDevices()
    const shown = useViewStore.getState().sidePane[sessionId]
    if (shown === undefined) {
      useViewStore.setState((s) => ({ sidePane: { ...s.sidePane, [sessionId]: 'devices' } }))
    } else if (shown !== 'devices') {
      useDevicesStore.setState((s) => ({ unseen: { ...s.unseen, [sessionId]: true } }))
    }
  })
  window.kettu.devices.onConnection((state) => {
    if (state === 'connected' && useDevicesStore.getState().loaded) void loadDevices()
  })
}
