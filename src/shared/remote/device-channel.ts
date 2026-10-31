// A device's side of a connection: the Noise initiator's handshake with a host it knows, or with
// the host of a pairing code and its secret, then the channel and the hello. The desktop app
// connects to other hosts with it, and the tests connect to the remote host as a device.

import { Channel } from './channel'
import { Handshake, type KeyPair } from './noise'
import type { Transport } from './transport'

export interface DeviceChannelOptions {
  transport: Transport
  /** The host's static public key: a known host's, or the one its pairing code carries. */
  hostKey: Uint8Array
  key: KeyPair
  /** A pairing code's secret: the handshake is IKpsk1 with it, IK without. */
  psk?: Uint8Array
  /** The first message on the channel; null sends none, as a device that never says hello. */
  hello: unknown
}

/** The channel once the host answered the handshake. */
export interface DeviceChannel {
  /** Each JSON message from the host, in order; the ones before a listener is set wait for it. */
  onMessage(listener: (value: unknown) => void): void
  /** Settles once the connection has ended and every message that came before it is handled. */
  readonly closed: Promise<void>
  send(value: unknown): Promise<void>
  close(): void
}

/** The connection ended before the host answered, as a host does for a key or a code it refuses. */
export class HandshakeDropped extends Error {
  constructor() {
    super('The host ended the connection without answering the handshake')
  }
}

/**
 * Sends the handshake's first message, then resolves with `opened`: the channel once the host's
 * answer finishes the handshake and the hello is sent, or a rejection, HandshakeDropped when the
 * connection ends first.
 */
export async function startDeviceChannel(
  options: DeviceChannelOptions,
): Promise<{ opened: Promise<DeviceChannel> }> {
  const { transport, hostKey, key, psk } = options
  const handshake = await Handshake.create({
    role: 'initiator',
    staticKey: key,
    remoteStaticKey: hostKey,
    ...(psk ? { pattern: 'IKpsk1' as const, psk } : { pattern: 'IK' as const }),
  })
  let channel: Channel | null = null
  let listener: ((value: unknown) => void) | null = null
  const waiting: unknown[] = []
  let reading: Promise<void> = Promise.resolve()
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve))
  let settle!: { resolve: (channel: DeviceChannel) => void; reject: (error: unknown) => void }
  let settled = false
  const opened = new Promise<DeviceChannel>((resolve, reject) => (settle = { resolve, reject }))
  // A refusal can come before the caller takes `opened`; it still hears it there.
  opened.catch(() => {})
  const fail = (error: unknown): void => {
    if (settled) return
    settled = true
    transport.close()
    settle.reject(error)
  }

  const api: DeviceChannel = {
    onMessage: (next) => {
      listener = next
      for (const value of waiting.splice(0)) next(value)
    },
    closed,
    send: async (value) => {
      if (!channel) throw new Error('The handshake is not done')
      await channel.send({ kind: 'json', value })
    },
    close: () => transport.close(),
  }

  // After the messages that arrived before the close are read.
  transport.onClose(() => {
    void reading.then(() => {
      resolveClosed()
      fail(new HandshakeDropped())
    })
  })
  transport.onMessage((message) => {
    reading = reading.then(async () => {
      if (channel) return channel.receive(message)
      if (settled) return
      try {
        await handshake.readMessage(message)
        channel = new Channel(await handshake.split(), {
          write: (frame) => transport.send(frame),
          // Byte streams come with uploads and media; until then they are dropped.
          message: (received) => {
            if (received.kind !== 'json') return
            if (listener) listener(received.value)
            else waiting.push(received.value)
          },
          end: () => transport.close(),
        })
        if (options.hello !== null) await channel.send({ kind: 'json', value: options.hello })
        settled = true
        settle.resolve(api)
      } catch (error) {
        fail(error)
      }
    })
  })
  try {
    transport.send(await handshake.writeMessage())
  } catch (error) {
    fail(error)
  }
  return { opened }
}
