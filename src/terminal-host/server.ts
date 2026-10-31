import type { PortChannel } from '@shared/port-channel'
import type { FromPort, PortError, ToPort } from '@shared/port-rpc'
import type { TerminalEvent, TerminalMethod } from '@shared/terminal-host'
import { TerminalError } from './terminals'
import { ValidationError, validators } from './validate'

type Port = PortChannel<FromPort<TerminalEvent>>

export type Handlers = {
  [M in TerminalMethod]: (port: string, params: ReturnType<(typeof validators)[M]>) => unknown
}

/** The terminal side of each renderer port: the shared envelope, validation and dispatch. */
export class PortServer {
  private readonly ports = new Map<string, Port>()
  private nextPort = 1

  constructor(
    private readonly handlers: Handlers,
    private readonly onClose: (port: string) => void,
    private readonly warn: (message: string) => void,
  ) {}

  attach(port: Port, windowId: number): void {
    const id = `${windowId}:${this.nextPort++}`
    this.ports.set(id, port)
    port.onMessage((data) => void this.receive(id, port, data))
    port.onClose(() => {
      this.ports.delete(id)
      this.onClose(id)
    })
  }

  send(portId: string, event: TerminalEvent): void {
    this.post(this.ports.get(portId), { type: 'event', event })
  }

  broadcast(event: TerminalEvent): void {
    for (const port of this.ports.values()) this.post(port, { type: 'event', event })
  }

  closeAll(): void {
    for (const port of this.ports.values()) port.close()
    this.ports.clear()
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
