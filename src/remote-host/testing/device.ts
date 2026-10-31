// Test helper: a paired device's side of a connection. It runs the Noise initiator, says hello on
// the channel and speaks the host protocol through a TestPort.

import { Channel } from '@shared/remote/channel'
import { Handshake, type KeyPair } from '@shared/remote/noise'
import { PROTOCOL_VERSION, type Addresses, type Closing, type Hello } from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'
import { TestPort } from '../../agent-host/testing/harness'

export interface TestDevice {
  /** The host's first message after the handshake: its welcome, or why it closes. */
  first: Promise<unknown>
  /** The host protocol, once welcomed. */
  port: TestPort
  /** The host's closing message, or null when the connection ended without one. */
  closing: Promise<Closing | null>
  /** The host's addresses messages, as they came. */
  addresses: Addresses[]
  /** Sends a JSON message on the channel as it is. */
  send(value: unknown): Promise<void>
  close(): void
}

export interface TestDeviceOptions {
  transport: Transport
  hostKey: Uint8Array
  key: KeyPair
  /** Fields over the default hello, or null to send none. */
  hello?: Partial<Hello> | Record<string, unknown> | null
}

export async function connectDevice(options: TestDeviceOptions): Promise<TestDevice> {
  const { transport, hostKey, key } = options
  const handshake = await Handshake.create({
    role: 'initiator',
    pattern: 'IK',
    staticKey: key,
    remoteStaticKey: hostKey,
  })
  const port = new TestPort()
  let channel: Channel | null = null
  let welcomed = false
  let closingMessage: Closing | null = null
  const addresses: Addresses[] = []
  let resolveFirst!: (value: unknown) => void
  let resolveClosing!: (closing: Closing | null) => void
  const first = new Promise<unknown>((resolve) => (resolveFirst = resolve))
  const closing = new Promise<Closing | null>((resolve) => (resolveClosing = resolve))

  const received = (value: unknown): void => {
    const type = (value as { type?: unknown } | null)?.type
    if (!welcomed) {
      welcomed = true
      resolveFirst(value)
    }
    if (type === 'closing') closingMessage = value as Closing
    else if (type === 'addresses') addresses.push(value as Addresses)
    else if (type !== 'welcome') port.send(value as Parameters<TestPort['send']>[0])
  }

  let reading: Promise<void> = Promise.resolve()
  // After the messages that arrived before the close are read.
  transport.onClose(() => void reading.then(() => resolveClosing(closingMessage)))
  transport.onMessage((message) => {
    reading = reading
      .then(async () => {
        if (channel) return channel.receive(message)
        await handshake.readMessage(message)
        channel = new Channel(await handshake.split(), {
          write: (frame) => transport.send(frame),
          message: (channelMessage) => {
            if (channelMessage.kind === 'json') received(channelMessage.value)
          },
          end: () => transport.close(),
        })
        if (options.hello === null) return
        const hello = {
          type: 'hello',
          protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
          client: { kind: 'ios', version: '1.0.0', platform: 'ios' },
          ...options.hello,
        }
        await channel.send({ kind: 'json', value: hello })
      })
      .catch(() => transport.close())
  })
  port.onMessage((data) => void channel?.send({ kind: 'json', value: data }))
  transport.send(await handshake.writeMessage())

  return {
    first,
    port,
    closing,
    addresses,
    send: async (value) => {
      if (!channel) throw new Error('The handshake is not done')
      await channel.send({ kind: 'json', value })
    },
    close: () => transport.close(),
  }
}
