import { app, MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import {
  DEVICE_CALL_TIMEOUT_MS,
  type DeviceCall,
  type DeviceCallAnswer,
} from '@shared/device-agent'
import type { DeviceHostToMain, MainToDeviceHost } from '@shared/host-control'
import type { PortDevice } from '@shared/remote/device'
import deviceHostPath from '../device-host/index?modulePath'
import { createLogger } from './log'
import { UtilityHost, type UtilityHostEvent, type UtilityHostState } from './utility-host'

const log = createLogger('device-host')

export interface DeviceHostDeps {
  /** Whether paired devices may use this computer's mobile devices. */
  allowDevices(): boolean
}

/**
 * Main's side of the device host, which starts on the first window's or device's port, or on the
 * first device tool call an agent makes.
 */
export class DeviceHost {
  private readonly host: UtilityHost<MainToDeviceHost, DeviceHostToMain>
  private readonly calls = new Map<number, (answer: DeviceCallAnswer) => void>()
  private nextCall = 1

  constructor(deps: DeviceHostDeps) {
    this.host = new UtilityHost<MainToDeviceHost, DeviceHostToMain>({
      label: 'device-host',
      channel: 'device-host',
      modulePath: deviceHostPath,
      serviceName: 'Kettu Device Host',
      initMessage: () => ({
        type: 'device-host:init',
        platform: process.platform,
        appVersion: app.getVersion(),
        nodeRuntime: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
        dataDir: app.getPath('userData'),
        resourcesPath: app.isPackaged ? process.resourcesPath : null,
        allowDevices: deps.allowDevices(),
      }),
      connectMessage: (windowId) => ({ type: 'device-host:connect', windowId }),
      shutdownMessage: { type: 'device-host:shutdown' },
      readyType: 'device-host:ready',
      stoppedType: 'device-host:stopped',
      onMessage: (message) => this.receive(message),
      onReady: () => this.flushPending(),
      onExit: () => {
        for (const resolve of this.calls.values()) {
          resolve({ error: { code: 'unavailable', message: 'The device host stopped' } })
        }
        this.calls.clear()
      },
    })
  }

  get state(): UtilityHostState {
    return this.host.state
  }

  history(): UtilityHostEvent[] {
    return this.host.history()
  }

  connect(webContents: WebContents): void {
    this.host.connect(webContents)
  }

  revoke(webContents: WebContents): void {
    this.host.revoke(webContents)
  }

  /** A port for a paired device, starting the host if it has not run yet; null while it cannot run. */
  connectDevice(device: PortDevice): MessagePortMain | null {
    this.host.start()
    const { port1, port2 } = new MessageChannelMain()
    if (this.host.post({ type: 'device-host:connect', windowId: -1, device }, [port1])) return port2
    port1.close()
    port2.close()
    return null
  }

  restart(): void {
    this.host.restart()
  }

  setAllowDevices(allowed: boolean): void {
    this.host.post({ type: 'device-host:allow-devices', allowed })
  }

  endSessions(sessionIds: string[]): void {
    this.host.post({ type: 'device-host:sessions-ended', sessionIds })
  }

  /** Runs an agent's device call, starting the host when it is not running. */
  call(call: DeviceCall): Promise<DeviceCallAnswer> {
    this.host.start()
    const callId = this.nextCall++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.calls.delete(callId)
        resolve({ error: { code: 'failed', message: 'The device did not answer in time' } })
      }, DEVICE_CALL_TIMEOUT_MS)
      this.calls.set(callId, (answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
      if (!this.host.post({ type: 'device-host:call', callId, call })) {
        // The host is still starting; the post is retried once it reports ready.
        this.pending.push({ callId, call })
      }
    })
  }

  private readonly pending: { callId: number; call: DeviceCall }[] = []

  flushPending(): void {
    for (const { callId, call } of this.pending.splice(0)) {
      if (!this.host.post({ type: 'device-host:call', callId, call }))
        this.pending.push({ callId, call })
    }
  }

  stop(): Promise<void> {
    return this.host.stop()
  }

  private receive(message: DeviceHostToMain): void {
    if (message.type !== 'device-host:answer') {
      log.warn(`Ignored unknown message "${message.type}"`)
      return
    }
    const resolve = this.calls.get(message.callId)
    if (!resolve) return
    this.calls.delete(message.callId)
    resolve(message.answer)
  }
}
