import type { PortChannel } from '@shared/port-channel'
import type { FromPort, PortError, ToPort } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import type { TerminalEvent, TerminalMethod } from '@shared/terminal-host'
import { TerminalError } from './terminals'
import { ValidationError, validators } from './validate'

type Port = PortChannel<FromPort<TerminalEvent>>

export type Handlers = {
  [M in TerminalMethod]: (port: string, params: ReturnType<(typeof validators)[M]>) => unknown
}

/**
 * The terminal side of each port, a window's or a paired device's: the shared envelope, validation
 * and dispatch. A device's port is served only while the owner allows devices the terminal, which
 * the remote host checks too, so a remote host that misbehaves cannot widen it.
 */
export class PortServer {
  private readonly ports = new Map<string, Port>()
  /** The ports that serve a paired device. */
  private readonly devices = new Map<string, PortDevice>()
  private allowDevices = false
  private nextPort = 1

  constructor(
    private readonly handlers: Handlers,
    private readonly onClose: (port: string) => void,
    private readonly warn: (message: string) => void,
  ) {}

  /** Serves a window's port, or a paired device's when `device` names it. */
  attach(port: Port, windowId: number, device: PortDevice | null = null): void {
    const id = `${windowId}:${this.nextPort++}`
    this.ports.set(id, port)
    if (device) this.devices.set(id, device)
    port.onMessage((data) => void this.receive(id, port, data))
    port.onClose(() => this.closed(id))
  }

  isDevice(portId: string): boolean {
    return this.devices.has(portId)
  }

  /** Whether devices' ports are served; turning it off closes them. */
  setAllowDevices(allowed: boolean): void {
    this.allowDevices = allowed
    if (allowed) return
    for (const id of [...this.devices.keys()]) {
      const port = this.ports.get(id)
      this.closed(id)
      port?.close()
    }
  }

  send(portId: string, event: TerminalEvent): void {
    this.post(this.ports.get(portId), { type: 'event', event })
  }

  broadcast(event: TerminalEvent): void {
    for (const [id, port] of this.ports) {
      if (this.allowDevices || !this.devices.has(id)) this.post(port, { type: 'event', event })
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
      this.warn(`Device ${device.id} asked for a terminal while devices may not use one`)
      this.reply(port, request.id, {
        code: 'terminal_not_allowed',
        message: 'This computer does not allow devices to use its terminal',
      })
      return
    }
    const method = request.method as TerminalMethod
    if (typeof method !== 'string' || !Object.hasOwn(validators, method)) {
      this.reply(port, request.id, {
        code: 'unknown_method',
        message: `Unknown method "${String(method)}"`,
      })
      return
    }
    try {
      const params = validators[method](request.params)
      const handler = this.handlers[method] as (port: string, params: unknown) => unknown
      const result = await handler(portId, params)
      this.post(port, { type: 'response', id: request.id, result: result ?? null })
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
    this.post(port, { type: 'error', id, error })
  }

  private post(port: Port | undefined, message: FromPort<TerminalEvent>): void {
    port?.send(message)
  }
}

function toPortError(error: unknown): PortError {
  if (error instanceof ValidationError) return { code: 'invalid_params', message: error.message }
  if (error instanceof TerminalError) return { code: error.code, message: error.message }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}
