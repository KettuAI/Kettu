// Test helper: a device's side of a connection, paired or pairing. It runs the shared device
// channel, says hello and speaks the host protocol through a TestPort, uploading and downloading
// byte streams as a device does.

import { startDeviceChannel, type DeviceChannel } from '@shared/remote/device-channel'
import type { KeyPair } from '@shared/remote/noise'
import { PROTOCOL_VERSION, type Addresses, type Closing, type Hello } from '@shared/remote/protocol'
import type { StreamCancel } from '@shared/remote/streams'
import type { Transport } from '@shared/remote/transport'
import { TestPort } from '../../agent-host/testing/harness'

/** A stream the host sends, as far as it has come. */
export interface HostStream {
  parts: Uint8Array[]
  received: number
  ended: boolean
  cancel: StreamCancel | null
}

export interface TestDevice {
  /** The host's first message after the handshake: its welcome, or why it closes. */
  first: Promise<unknown>
  /** The host protocol, once welcomed. */
  port: TestPort
  /** The host's closing message, or null when the connection ended without one. */
  closing: Promise<Closing | null>
  /** The host's addresses messages, as they came. */
  addresses: Addresses[]
  /** Messages around the host protocol after the welcome, such as `renamed`. */
  notices: unknown[]
  /** Sends a JSON message on the channel as it is. */
  send(value: unknown): Promise<void>
  sendBytes(stream: number, data: Uint8Array): Promise<void>
  /**
   * Opens the next upload and sends `data` on it, `chunk` bytes at a time, then ends it unless
   * `end` is false; resolves with its id. `size` is what the open says, the data's unless given.
   */
  upload(
    data: Uint8Array,
    options?: { chunk?: number; end?: boolean; size?: number },
  ): Promise<number>
  /** The host's streams, by id. */
  streams: Map<number, HostStream>
  /** The bytes of a host stream once it ends; rejects with the host's cancel when it gives up. */
  download(stream: number): Promise<Uint8Array>
  /** The host's stream.cancel messages, as they came. */
  cancels: StreamCancel[]
  close(): void
}

export interface TestDeviceOptions {
  transport: Transport
  hostKey: Uint8Array
  key: KeyPair
  /** Fields over the default hello, or null to send none. */
  hello?: Partial<Hello> | Record<string, unknown> | null
  /** A pairing code's secret: the handshake is IKpsk1 with it. */
  psk?: Uint8Array
}

export async function connectDevice(options: TestDeviceOptions): Promise<TestDevice> {
  const { transport, hostKey, key, psk } = options
  const port = new TestPort()
  let channel: DeviceChannel | null = null
  let welcomed = false
  let closingMessage: Closing | null = null
  const addresses: Addresses[] = []
  let resolveFirst!: (value: unknown) => void
  let resolveClosing!: (closing: Closing | null) => void
  const first = new Promise<unknown>((resolve) => (resolveFirst = resolve))
  const closing = new Promise<Closing | null>((resolve) => (resolveClosing = resolve))
  const notices: unknown[] = []
  const streams = new Map<number, HostStream>()
  const cancels: StreamCancel[] = []
  const waiting = new Set<() => void>()
  let nextUpload = 1
  const changed = (): void => {
    for (const check of [...waiting]) check()
  }
  const streamOf = (id: number): HostStream => {
    let stream = streams.get(id)
    if (!stream) {
      stream = { parts: [], received: 0, ended: false, cancel: null }
      streams.set(id, stream)
    }
    return stream
  }

  const received = (value: unknown): void => {
    const type = (value as { type?: unknown } | null)?.type
    if (!welcomed) {
      welcomed = true
      resolveFirst(value)
    }
    if (type === 'closing') closingMessage = value as Closing
    else if (type === 'addresses') addresses.push(value as Addresses)
    else if (type === 'renamed') notices.push(value)
    else if (type === 'stream.end') {
      streamOf((value as { stream: number }).stream).ended = true
      changed()
    } else if (type === 'stream.cancel') {
      const cancel = value as StreamCancel
      cancels.push(cancel)
      if (cancel.stream % 2 === 0) streamOf(cancel.stream).cancel = cancel
      changed()
    } else if (type !== 'welcome') port.send(value as Parameters<TestPort['send']>[0])
  }

  const hello =
    options.hello === null
      ? null
      : {
          type: 'hello',
          protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
          client: { kind: 'ios', version: '1.0.0', platform: 'ios' },
          ...options.hello,
        }
  const { opened } = await startDeviceChannel({ transport, hostKey, key, psk, hello })
  opened.then(
    (open) => {
      channel = open
      open.onMessage(received)
      open.onBytes((id, data) => {
        const stream = streamOf(id)
        stream.parts.push(data.slice())
        stream.received += data.length
      })
      void open.closed.then(() => resolveClosing(closingMessage))
    },
    () => resolveClosing(null),
  )
  port.onMessage((data) => void channel?.send(data))

  return {
    first,
    port,
    closing,
    addresses,
    notices,
    send: async (value) => {
      if (!channel) throw new Error('The handshake is not done')
      await channel.send(value)
    },
    sendBytes: async (stream, data) => {
      if (!channel) throw new Error('The handshake is not done')
      await channel.sendBytes(stream, data)
    },
    upload: async (data, options = {}) => {
      if (!channel) throw new Error('The handshake is not done')
      const stream = nextUpload
      nextUpload += 2
      const chunk = options.chunk ?? 64 * 1024
      await channel.send({ type: 'stream.open', stream, size: options.size ?? data.length })
      for (let offset = 0; offset < data.length; offset += chunk) {
        await channel.sendBytes(stream, data.subarray(offset, offset + chunk))
      }
      if (options.end !== false) await channel.send({ type: 'stream.end', stream })
      return stream
    },
    streams,
    download: (id) =>
      new Promise((resolve, reject) => {
        const check = (): void => {
          const stream = streams.get(id)
          if (stream?.cancel) {
            waiting.delete(check)
            reject(stream.cancel)
          } else if (stream?.ended) {
            waiting.delete(check)
            resolve(new Uint8Array(Buffer.concat(stream.parts)))
          }
        }
        waiting.add(check)
        check()
      }),
    cancels,
    close: () => transport.close(),
  }
}
