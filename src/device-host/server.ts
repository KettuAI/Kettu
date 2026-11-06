import { withOperation } from '@shared/log/process-log'
import { logRequest } from '@shared/log/requests'
import type { DeviceEvent, DeviceMethod } from '@shared/device-host'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort, PortError, ToPort } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import { DeviceError } from './devices'
import { ValidationError, validators } from './validate'

type Port = PortChannel<FromPort<DeviceEvent>>

export type Handlers = {
  [M in DeviceMethod]: (port: string, params: ReturnType<(typeof validators)[M]>) => unknown
}

/**
 * The device side of each port, a window's or a paired device's: the shared envelope, validation
 * and dispatch. A paired device's port is served only while the owner lets devices use the host.
 */
export class PortServer {
  private readonly ports = new Map<string, Port>()
  private readonly devices = new Map<string, PortDevice>()
  private allowDevices = false
  private nextPort = 1

  constructor(
    private readonly handlers: Handlers,
    private readonly onOpen: () => void,
    private readonly onClose: (port: string) => void,
    private readonly warn: (message: string) => void,
  ) {}

  get size(): number {
    return this.ports.size
  }

  attach(port: Port, windowId: number, device: PortDevice | null = null): void {
    const id = `${windowId}:${this.nextPort++}`
    this.ports.set(id, port)
    if (device) this.devices.set(id, device)
    port.onMessage((data) => void this.receive(id, port, data))
    port.onClose(() => this.closed(id))
    this.onOpen()
  }

  setAllowDevices(allowed: boolean): void {
    this.allowDevices = allowed
    if (allowed) return
    for (const id of [...this.devices.keys()]) {
      const port = this.ports.get(id)
      this.closed(id)
      port?.close()
    }
  }

  send(portId: string, event: DeviceEvent): void {
    this.ports.get(portId)?.send({ type: 'event', event })
  }

  broadcast(event: DeviceEvent): void {
    for (const [id, port] of this.ports) {
      if (this.allowDevices || !this.devices.has(id)) port.send({ type: 'event', event })
    }
  }

  closeAll(): void {
    for (const port of this.ports.values()) port.close()
    this.ports.clear()
    this.devices.clear()
  }

  private async receive(portId: string, port: Port, data: unknown): Promise<void> {
    const request = data as ToPort
    if (
      typeof request !== 'object' ||
      request === null ||
      request.type !== 'request' ||
      !Number.isSafeInteger(request.id)
    ) {
      this.warn('Ignored a malformed message')
      return
    }
    const device = this.devices.get(portId)
    if (device && !this.allowDevices) {
      this.reply(port, request.id, {
        code: 'forbidden',
        message: 'This computer does not let devices use its mobile devices',
      })
      return
    }
    const method = request.method as DeviceMethod
    if (typeof method !== 'string' || !Object.hasOwn(validators, method)) {
      this.reply(port, request.id, {
        code: 'unknown_method',
        message: `Unknown method "${String(method)}"`,
      })
      return
    }
    try {
      const params = validators[method](request.params)
      // Frames are acknowledged many times a second; the log keeps the rest.
      if (method !== 'devices.ack' && method !== 'devices.input') {
        logRequest(method, params, device?.id ?? null)
      }
      const handler = this.handlers[method] as (port: string, params: unknown) => unknown
      const result = await withOperation(`${portId}.${request.id}`, () => handler(portId, params))
      port.send({ type: 'response', id: request.id, result: result ?? null })
    } catch (error) {
      this.reply(port, request.id, toPortError(error))
    }
  }

  private closed(id: string): void {
    if (!this.ports.delete(id)) return
    this.devices.delete(id)
    this.onClose(id)
  }

  private reply(port: Port, id: number, error: PortError): void {
    port.send({ type: 'error', id, error })
  }
}

function toPortError(error: unknown): PortError {
  if (error instanceof ValidationError) return { code: 'invalid_params', message: error.message }
  if (error instanceof DeviceError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    }
  }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}
