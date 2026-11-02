// A device's forwards to dev servers on this host: a desktop app's page opens a port an agent of
// the session navigated it to, and each of its TCP connections comes as a two-way byte stream,
// connected here to this host's own loopback. Only the ports the agent host's browser calls name
// are granted, to that session and the device's session with the host, and go with the latter.

import net from 'node:net'
import { isBrowserForward, type BrowserForward } from '@shared/browser'
import type { PortError } from '@shared/port-rpc'
import { MAX_FORWARDS, type StreamCancel, type StreamEnd } from '@shared/remote/streams'
import type { Transport } from '@shared/remote/transport'
import type { LogFn } from '../agent-host/storage'
import { HIGH_WATER } from './downloads'

/** Bytes a connection may hold for its dev server before the device's stream is given up. */
const MAX_UNWRITTEN = 8 * 1024 * 1024

/** Grants a device session keeps, over all its sessions' pages. */
const MAX_GRANTS = 256

export type Connect = (host: BrowserForward['host'], port: number) => net.Socket

const connectLoopback: Connect = (host, port) =>
  net.connect({ host, port, allowHalfOpen: true, autoSelectFamily: true })

export interface HostForwardsOptions {
  /** A JSON message on the session, in order with its bytes. */
  send(message: StreamEnd | StreamCancel): void
  sendBytes(stream: number, data: Uint8Array): void
  /** The session's outbox, which a connection waits on while it holds more than `highWater`. */
  transport: Pick<Transport, 'buffered' | 'drained'>
  highWater?: number
  max?: number
  connect?: Connect
  log: LogFn
}

interface Forwarded {
  socket: net.Socket
  /** This side sent `stream.end`, as its dev server ended its direction. */
  sentEnd: boolean
  /** The device sent `stream.end`. */
  gotEnd: boolean
  /** It went without a word to the device: cancelled by it, or with its connection. */
  quiet: boolean
}

function grantKey(sessionId: string, host: string, port: number): string {
  return `${sessionId}\n${host}\n${port}`
}

export class HostForwards {
  private readonly grants = new Set<string>()
  private readonly forwards = new Map<number, Forwarded>()
  private draining = false

  constructor(private readonly options: HostForwardsOptions) {}

  /** A message from the agent host to the device: a call that names a forward grants its port. */
  observe(data: unknown): void {
    const { type, event } = (data ?? {}) as { type?: unknown; event?: unknown }
    if (type !== 'event' || typeof event !== 'object' || event === null) return
    const { type: name, call } = event as { type?: unknown; call?: unknown }
    if (name !== 'browser.call' || typeof call !== 'object' || call === null) return
    const { sessionId, forward } = call as { sessionId?: unknown; forward?: unknown }
    if (typeof sessionId !== 'string' || !isBrowserForward(forward)) return
    if (this.grants.size >= MAX_GRANTS) return
    this.grants.add(grantKey(sessionId, forward.host, forward.port))
  }

  has(stream: number): boolean {
    return this.forwards.has(stream)
  }

  /** The device's `forward.open` on `stream`, an id the session already took as the device's. */
  open(stream: number, value: Record<string, unknown>): void {
    const { sessionId, host, port } = value
    const forward = { host, port }
    if (
      typeof sessionId !== 'string' ||
      !isBrowserForward(forward) ||
      !this.grants.has(grantKey(sessionId, forward.host, forward.port))
    ) {
      return this.refuse(stream, {
        code: 'forbidden',
        message: 'No agent of the session opened that port on the host',
      })
    }
    const max = this.options.max ?? MAX_FORWARDS
    if (this.forwards.size >= max) {
      return this.refuse(stream, {
        code: 'busy',
        message: `A device may have at most ${max} forwarded connections at once`,
      })
    }
    const socket = (this.options.connect ?? connectLoopback)(forward.host, forward.port)
    const forwarded: Forwarded = { socket, sentEnd: false, gotEnd: false, quiet: false }
    this.forwards.set(stream, forwarded)
    socket.on('data', (data: Buffer) => this.toDevice(stream, forwarded, data))
    socket.on('end', () => {
      if (this.forwards.get(stream) !== forwarded) return
      forwarded.sentEnd = true
      this.options.send({ type: 'stream.end', stream })
    })
    let failure: string | null = null
    socket.on('error', (error: NodeJS.ErrnoException) => {
      failure = error.code ?? error.name
    })
    socket.on('close', () => {
      if (this.forwards.get(stream) !== forwarded) return
      this.forwards.delete(stream)
      if (forwarded.quiet || (forwarded.sentEnd && forwarded.gotEnd)) return
      if (failure) this.options.log('info', `A forward to port ${forward.port} failed: ${failure}`)
      const message =
        failure === 'ECONNREFUSED'
          ? `Nothing listens on port ${forward.port} on the host`
          : 'The connection on the host ended'
      this.options.send({ type: 'stream.cancel', stream, error: { code: 'unavailable', message } })
    })
  }

  /** Bytes from the device; false when `stream` is no forward's. */
  bytes(stream: number, data: Uint8Array): boolean {
    const forwarded = this.forwards.get(stream)
    if (!forwarded) return false
    if (forwarded.gotEnd) return true
    forwarded.socket.write(data)
    if (forwarded.socket.writableLength > MAX_UNWRITTEN) {
      this.drop(stream, forwarded)
      this.refuse(stream, { code: 'busy', message: 'The dev server on the host reads too slowly' })
    }
    return true
  }

  /** The device ended its direction; false when `stream` is no forward's. */
  end(stream: number): boolean {
    const forwarded = this.forwards.get(stream)
    if (!forwarded) return false
    forwarded.gotEnd = true
    forwarded.socket.end()
    return true
  }

  /** The device gave the connection up; false when `stream` is no forward's. */
  cancel(stream: number): boolean {
    const forwarded = this.forwards.get(stream)
    if (!forwarded) return false
    this.drop(stream, forwarded)
    return true
  }

  /** The device's connection dropped: its bytes on the way are lost, so its connections go. */
  dropConnections(): void {
    for (const [stream, forwarded] of [...this.forwards]) this.drop(stream, forwarded)
  }

  /** The device's session ended: its connections and grants go. */
  close(): void {
    this.dropConnections()
    this.grants.clear()
  }

  private toDevice(stream: number, forwarded: Forwarded, data: Buffer): void {
    if (this.forwards.get(stream) !== forwarded) return
    this.options.sendBytes(stream, new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    if (this.options.transport.buffered() <= (this.options.highWater ?? HIGH_WATER)) return
    // Every connection waits until the device has read what the session holds for it.
    for (const { socket } of this.forwards.values()) socket.pause()
    if (this.draining) return
    this.draining = true
    void this.options.transport.drained().then(() => {
      this.draining = false
      for (const { socket } of this.forwards.values()) socket.resume()
    })
  }

  private drop(stream: number, forwarded: Forwarded): void {
    forwarded.quiet = true
    this.forwards.delete(stream)
    forwarded.socket.destroy()
  }

  private refuse(stream: number, error: PortError): void {
    this.options.send({ type: 'stream.cancel', stream, error })
  }
}
