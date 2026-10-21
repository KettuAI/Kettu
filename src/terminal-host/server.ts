import type { MessagePortMain } from 'electron'
import type { FromPort, PortError, ToPort } from '@shared/port-rpc'
import type { TerminalEvent, TerminalMethod } from '@shared/terminal-host'
import { TerminalError } from './terminals'
import { ValidationError, validators } from './validate'

export type Handlers = {
  [M in TerminalMethod]: (port: string, params: ReturnType<(typeof validators)[M]>) => unknown
}

/** The terminal side of each renderer port: the shared envelope, validation and dispatch. */
export class PortServer {
  private readonly ports = new Map<string, MessagePortMain>()
  private nextPort = 1

  constructor(
    private readonly handlers: Handlers,
    private readonly onClose: (port: string) => void,
    private readonly warn: (message: string) => void,
  ) {}

  attach(port: MessagePortMain, windowId: number): void {
    const id = `${windowId}:${this.nextPort++}`
    this.ports.set(id, port)
    port.on('message', ({ data }) => void this.receive(id, port, data))
    port.on('close', () => {
      this.ports.delete(id)
      this.onClose(id)
    })
    port.start()
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

  private async receive(portId: string, port: MessagePortMain, data: unknown): Promise<void> {
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

  private reply(port: MessagePortMain, id: number, error: PortError): void {
    this.post(port, { type: 'error', id, error })
  }

  private post(port: MessagePortMain | undefined, message: FromPort<TerminalEvent>): void {
    port?.postMessage(message)
  }
}

function toPortError(error: unknown): PortError {
  if (error instanceof ValidationError) return { code: 'invalid_params', message: error.message }
  if (error instanceof TerminalError) return { code: error.code, message: error.message }
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}
