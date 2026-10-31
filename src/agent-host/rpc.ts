// The clients' ports, windows' and paired devices': the request/response/event envelope,
// validation and dispatch.

import {
  HOST_METHODS,
  type HostEvent,
  type HostMethod,
  type HostParams,
  type HostResult,
} from '@shared/agent-host'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort, PortError } from '@shared/port-rpc'
import { forbiddenToDevices } from '@shared/remote/allow-list'
import type { PortDevice } from '@shared/remote/device'
import { HostError, isHostError } from './errors'

export interface RequestContext {
  portId: string
}

export type Handlers = {
  [M in HostMethod]: (
    params: HostParams<M>,
    ctx: RequestContext,
  ) => Promise<HostResult<M>> | HostResult<M>
}

export type Validators = { [M in HostMethod]: (params: unknown) => HostParams<M> }

export interface PortHubDeps {
  handlers: Handlers
  validators: Validators
  /** A port closed: its watches and retains go with it. */
  closed(portId: string): void
  log(level: 'info' | 'warn' | 'error', message: string): void
}

const METHODS: ReadonlySet<string> = new Set(HOST_METHODS)

function toPortError(error: unknown): PortError {
  if (isHostError(error)) return error.toPortError()
  return { code: 'internal', message: (error as Error)?.message ?? String(error) }
}

export class PortHub {
  private readonly ports = new Map<string, PortChannel<FromPort<HostEvent>>>()
  /** The ports that serve a paired device, which may do less than a window. */
  private readonly devices = new Map<string, PortDevice>()
  private counter = 0

  constructor(private readonly deps: PortHubDeps) {}

  /** Serves a window's port, or a paired device's when `device` names it. */
  add(channel: PortChannel<FromPort<HostEvent>>, device: PortDevice | null = null): string {
    const portId = `port-${++this.counter}`
    this.ports.set(portId, channel)
    if (device) this.devices.set(portId, device)
    channel.onMessage((data) => void this.receive(portId, channel, data))
    channel.onClose(() => {
      if (!this.ports.delete(portId)) return
      this.devices.delete(portId)
      this.deps.closed(portId)
    })
    return portId
  }

  has(portId: string): boolean {
    return this.ports.has(portId)
  }

  broadcast(event: HostEvent): void {
    for (const channel of this.ports.values()) channel.send({ type: 'event', event })
  }

  send(portIds: Iterable<string>, event: HostEvent): void {
    for (const portId of portIds) this.ports.get(portId)?.send({ type: 'event', event })
  }

  closeAll(): void {
    for (const [portId, channel] of [...this.ports]) {
      this.ports.delete(portId)
      this.devices.delete(portId)
      channel.close()
      this.deps.closed(portId)
    }
  }

  private async receive(
    portId: string,
    channel: PortChannel<FromPort<HostEvent>>,
    data: unknown,
  ): Promise<void> {
    const message = data as { type?: unknown; id?: unknown; method?: unknown; params?: unknown }
    if (typeof message !== 'object' || message === null || message.type !== 'request') {
      this.deps.log('warn', `Port ${portId} sent a message that is not a request`)
      return
    }
    const id = message.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      this.deps.log('warn', `Port ${portId} sent a request without a numeric id`)
      return
    }
    const reply = (response: FromPort<HostEvent>): void => {
      // The page may have gone while the request ran.
      if (this.ports.has(portId)) channel.send(response)
    }
    const method = message.method
    if (typeof method !== 'string' || !METHODS.has(method)) {
      reply({
        type: 'error',
        id,
        error: { code: 'unknown_method', message: `Unknown method "${String(method)}"` },
      })
      return
    }
    const device = this.devices.get(portId)
    if (device && forbiddenToDevices(method, message.params)) {
      this.deps.log('warn', `Device ${device.id} asked for ${method}, which devices may not call`)
      reply({
        type: 'error',
        id,
        error: { code: 'forbidden', message: `A paired device may not call "${method}"` },
      })
      return
    }
    try {
      const result = await this.dispatch(method as HostMethod, message.params, { portId })
      reply({ type: 'response', id, result })
    } catch (error) {
      const portError = toPortError(error)
      if (portError.code === 'internal') {
        this.deps.log('error', `${method} failed: ${(error as Error)?.stack ?? String(error)}`)
      }
      reply({ type: 'error', id, error: portError })
    }
  }

  private async dispatch<M extends HostMethod>(
    method: M,
    raw: unknown,
    ctx: RequestContext,
  ): Promise<HostResult<M>> {
    let params: HostParams<M>
    try {
      params = this.deps.validators[method](raw)
    } catch (error) {
      if (isHostError(error)) throw error
      throw new HostError('invalid_params', (error as Error).message)
    }
    return this.deps.handlers[method](params, ctx)
  }
}
