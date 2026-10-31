// How a device's connection reaches the host, whatever carries it: direct TCP, SSH or the relay.
// The host's side of the channel sees only this, so each of them plugs in without changing it.

/** One connection: each message is one Noise message, handshake or transport, whole and in order. */
export interface Transport {
  send(message: Uint8Array): void
  /** Messages that arrive before a listener is set wait for it. */
  onMessage(listener: (message: Uint8Array) => void): void
  /** The connection ended, from either side. */
  onClose(listener: () => void): void
  close(): void
}
