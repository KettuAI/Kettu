// Test helper: a device's side of a connection, paired or pairing. It runs the shared device
// channel, says hello and speaks the host protocol through a TestPort.

import { startDeviceChannel, type DeviceChannel } from '@shared/remote/device-channel'
import type { KeyPair } from '@shared/remote/noise'
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
  /** Messages around the host protocol after the welcome, such as `renamed`. */
  notices: unknown[]
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

  const received = (value: unknown): void => {
    const type = (value as { type?: unknown } | null)?.type
    if (!welcomed) {
      welcomed = true
      resolveFirst(value)
    }
    if (type === 'closing') closingMessage = value as Closing
    else if (type === 'addresses') addresses.push(value as Addresses)
    else if (type === 'renamed') notices.push(value)
    else if (type !== 'welcome') port.send(value as Parameters<TestPort['send']>[0])
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
    close: () => transport.close(),
  }
}
