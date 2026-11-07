// A paired device's port to the device host: its `devices.*` requests go there, and the host's
// answers and events come back. The channel carries JSON, so frames, screenshots and the device
// frame's pictures travel as base64; each device acknowledges its own frames, so a slow phone skips ahead on its own.

import { DEVICE_METHODS } from '@shared/device-host'
import type { PortChannel } from '@shared/port-channel'
import type { PortError } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import type { LogFn } from '../agent-host/storage'

/** The device host's own methods; the agent host's `devices.*`, such as answering a card, are not. */
export function isDeviceMethod(method: unknown): method is string {
  return typeof method === 'string' && (DEVICE_METHODS as readonly string[]).includes(method)
}

const UNAVAILABLE: PortError = { code: 'unavailable', message: 'The device host is not running' }
const TOO_MANY: PortError = { code: 'busy', message: 'Too many device requests are waiting' }
const MAX_WAITING = 1024

type Request = { type: 'request'; id?: unknown; method: string; params?: unknown }

export interface DeviceDevicesOptions {
  device: PortDevice
  /** A port to the device host for the device, or null while it cannot have one. */
  open(device: PortDevice): Promise<PortChannel | null>
  send(value: unknown): void
  log: LogFn
}

function base64(value: unknown): string | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('base64')
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
  }
  return null
}

/** The host's message as the channel carries it: binary payloads as base64 strings. */
export function forChannel(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data
  const message = data as Record<string, unknown>
  if (message.type === 'event') {
    const event = message.event as Record<string, unknown> | null
    if (event?.type === 'device.frame') {
      const encoded = base64(event.data)
      return { ...message, event: { ...event, data: encoded ?? '' } }
    }
    return data
  }
  if (message.type === 'response') {
    const result = message.result as Record<string, unknown> | null
    if (!result || typeof result !== 'object') return data
    const png = base64(result.png)
    if (png !== null) return { ...message, result: { ...result, png } }
    const frame = result.frame as { images?: unknown } | null | undefined
    if (frame && Array.isArray(frame.images)) {
      const images = frame.images.map((image: Record<string, unknown>) => {
        const button = image.button as Record<string, unknown> | null | undefined
        return {
          ...image,
          png: base64(image.png) ?? '',
          ...(button && { button: { ...button, down: base64(button.down) } }),
        }
      })
      return { ...message, result: { ...result, frame: { ...frame, images } } }
    }
  }
  return data
}

export class DeviceDevices {
  private state: 'idle' | 'opening' | 'open' | 'ended' = 'idle'
  private port: PortChannel | null = null
  private generation = 0
  private readonly queued: Request[] = []
  private readonly waiting = new Set<number>()

  constructor(private readonly options: DeviceDevicesOptions) {}

  request(request: Request): void {
    if (this.state === 'ended') return
    if (this.queued.length + this.waiting.size >= MAX_WAITING)
      return this.refuse(request.id, TOO_MANY)
    if (this.state === 'open') return this.forward(request)
    this.queued.push(request)
    if (this.state === 'idle') void this.openPort()
  }

  /** Closes the port; with `error` the waiting requests get it and a later request opens again. */
  close(error: PortError | null): void {
    if (this.state === 'ended') return
    const port = this.port
    this.port = null
    this.generation++
    this.state = error ? 'idle' : 'ended'
    this.reset(error ?? UNAVAILABLE)
    port?.close()
  }

  private async openPort(): Promise<void> {
    this.state = 'opening'
    const generation = ++this.generation
    const port = await this.options.open(this.options.device).catch(() => null)
    if (generation !== this.generation) return port?.close()
    if (!port) {
      this.state = 'idle'
      return this.reset(UNAVAILABLE)
    }
    this.port = port
    this.state = 'open'
    port.onMessage((data) => {
      if (this.port !== port) return
      const { type, id } = (data ?? {}) as Record<string, unknown>
      if ((type === 'response' || type === 'error') && typeof id === 'number')
        this.waiting.delete(id)
      this.options.send(forChannel(data))
    })
    port.onClose(() => {
      if (this.port !== port) return
      this.options.log('warn', `The device port of paired device ${this.options.device.id} closed`)
      this.port = null
      this.state = 'idle'
      this.reset(UNAVAILABLE)
      this.options.send({ type: 'event', event: { type: 'devices.restarted' } })
    })
    for (const request of this.queued.splice(0)) this.forward(request)
  }

  private forward(request: Request): void {
    if (typeof request.id === 'number' && Number.isSafeInteger(request.id)) {
      this.waiting.add(request.id)
    }
    this.port?.send(request)
  }

  private reset(error: PortError): void {
    for (const request of this.queued.splice(0)) this.refuse(request.id, error)
    for (const id of this.waiting) this.refuse(id, error)
    this.waiting.clear()
  }

  private refuse(id: unknown, error: PortError): void {
    if (typeof id === 'number') this.options.send({ type: 'error', id, error })
  }
}
