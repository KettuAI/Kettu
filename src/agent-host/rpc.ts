// The clients' ports, windows' and paired devices': the request/response/event envelope,
// validation and dispatch.

import {
  HOST_METHODS,
  type DeviceResult,
  type HostEvent,
  type HostMethod,
  type HostParams,
  type HostResult,
  type SessionViewer,
} from '@shared/agent-host'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort, PortError } from '@shared/port-rpc'
import { withOperation, writeLog } from '@shared/log/process-log'
import { isReadMethod, logRequest } from '@shared/log/requests'
import { forbiddenToDevices } from '@shared/remote/allow-list'
import type { PortDevice } from '@shared/remote/device'
import { HostError, isHostError } from './errors'

export interface RequestContext {
  portId: string
  /** The paired device the port serves, or null for a window's. */
  device: PortDevice | null
}

/** A method's handler, which answers a paired device's port with its `DeviceResult`. */
export type Handlers = {
  [M in HostMethod]: (
    params: HostParams<M>,
    ctx: RequestContext,
  ) => Promise<HostResult<M> | DeviceResult<M>> | HostResult<M> | DeviceResult<M>
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

const BLOB = /^[0-9a-f]{64}$/

/**
 * The value with each image it names by hash in the thread store as one that cannot show, for a
 * device that did not send `IMAGE_REFS_FEATURE` and decodes an image only with its bytes; the
 * same value when it names none.
 */
function withoutImageRefs<T>(value: T): T {
  if (Array.isArray(value)) {
    let out: unknown[] | null = null
    value.forEach((item: unknown, index) => {
      const next = withoutImageRefs(item)
      if (next !== item) (out ??= [...value])[index] = next
    })
    return (out ?? value) as T
  }
  if (typeof value !== 'object' || value === null) return value
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value
  const record = value as Record<string, unknown>
  if (
    record.kind === 'image' &&
    typeof record.blob === 'string' &&
    BLOB.test(record.blob) &&
    typeof record.data !== 'string'
  ) {
    return { kind: 'unsupported', label: String(record.mimeType) } as T
  }
  let out: Record<string, unknown> | null = null
  for (const key of Object.keys(record)) {
    const item = record[key]
    const next = withoutImageRefs(item)
    if (next !== item) (out ??= { ...record })[key] = next
  }
  return (out ?? value) as T
}

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

  /** The paired device an open port serves; null for a window's and for a closed port. */
  deviceOf(portId: string): PortDevice | null {
    return this.devices.get(portId) ?? null
  }

  /** The latest open port of `deviceId` that runs browser calls, or null when it has none. */
  browserPort(deviceId: string): string | null {
    let found: string | null = null
    for (const [portId, device] of this.devices) {
      if (device.id === deviceId && device.browser) found = portId
    }
    return found
  }

  broadcast(event: HostEvent): void {
    let bytesOnly: HostEvent | null = null
    for (const [portId, channel] of this.ports) {
      const sent = this.readsImageRefs(portId) ? event : (bytesOnly ??= withoutImageRefs(event))
      channel.send({ type: 'event', event: sent })
    }
  }

  send(portIds: Iterable<string>, event: HostEvent): void {
    let bytesOnly: HostEvent | null = null
    for (const portId of portIds) {
      const sent = this.readsImageRefs(portId) ? event : (bytesOnly ??= withoutImageRefs(event))
      this.ports.get(portId)?.send({ type: 'event', event: sent })
    }
  }

  /** A window's port, or a device's that reads stored images by hash. */
  private readsImageRefs(portId: string): boolean {
    const device = this.devices.get(portId)
    return !device || device.imageRefs === true
  }

  /**
   * Who the ports `showing` are, as `to` is told: the host's windows as one, each device once, by
   * name, leaving out the computer or device `to` serves.
   */
  viewers(showing: readonly string[], to: string): SessionViewer[] {
    const own = this.devices.get(to)?.id ?? null
    let host = false
    const devices = new Map<string, PortDevice>()
    for (const portId of showing) {
      const device = this.devices.get(portId)
      if (!device) host ||= own !== null
      else if (device.id !== own) devices.set(device.id, device)
    }
    const named = [...devices.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    )
    return [
      ...(host ? [{ kind: 'host' as const }] : []),
      ...named.map(({ id, name }) => ({ kind: 'device' as const, id, name })),
    ]
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
      if (!this.ports.has(portId)) return
      const bytesOnly = response.type === 'response' && !this.readsImageRefs(portId)
      channel.send(
        bytesOnly ? { ...response, result: withoutImageRefs(response.result) } : response,
      )
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
    const op = `${portId}.${id}`
    try {
      const ctx = { portId, device: device ?? null }
      const result = await withOperation(op, () =>
        this.dispatch(method as HostMethod, message.params, ctx),
      )
      reply({ type: 'response', id, result })
    } catch (error) {
      const portError = toPortError(error)
      if (portError.code === 'internal') {
        this.deps.log('error', `${method} failed: ${(error as Error)?.stack ?? String(error)}`)
      } else if (!isReadMethod(method)) {
        withOperation(op, () => writeLog('info', 'request', `${method} failed: ${portError.code}`))
      }
      reply({ type: 'error', id, error: portError })
    }
  }

  private async dispatch<M extends HostMethod>(
    method: M,
    raw: unknown,
    ctx: RequestContext,
  ): Promise<HostResult<M> | DeviceResult<M>> {
    let params: HostParams<M>
    try {
      params = this.deps.validators[method](raw)
    } catch (error) {
      if (isHostError(error)) throw error
      throw new HostError('invalid_params', (error as Error).message)
    }
    logRequest(method, params, ctx.device?.id ?? null)
    return this.deps.handlers[method](params, ctx)
  }
}
