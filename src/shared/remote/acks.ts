// A device's count of what the host sent it on its session, from protocol version 2, and its
// acknowledgements of it: at once after a burst, otherwise a moment after the last message, so one
// covers many. The count is what the device's hello names to resume the session.

import type { Ack } from './protocol'

/** Messages received before they are acknowledged at once rather than a moment later. */
export const ACK_EVERY = 32

/** Stream bytes received before they are acknowledged at once. */
export const ACK_BYTES = 256 * 1024

/** How long an acknowledgement waits for more messages to cover. */
export const ACK_MS = 20

export class Acknowledger {
  private count = 0
  private unacked = 0
  private unackedBytes = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  /** `send` sends on the session's connection now, and drops the ack while there is none. */
  constructor(private readonly send: (ack: Ack) => void) {}

  /** The host's messages received on the session, JSON and stream bytes alike. */
  get received(): number {
    return this.count
  }

  /** One more message came, `bytes` long when it was stream bytes, and was applied. */
  counted(bytes = 0): void {
    this.count++
    this.unacked++
    this.unackedBytes += bytes
    if (this.unacked >= ACK_EVERY || this.unackedBytes >= ACK_BYTES) return this.flush()
    this.timer ??= setTimeout(() => this.flush(), ACK_MS)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.unacked === 0) return
    this.unacked = 0
    this.unackedBytes = 0
    this.send({ type: 'ack', received: this.count })
  }

  /** The connection went: the hello that resumes the session says the count instead. */
  pause(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.unacked = 0
    this.unackedBytes = 0
  }

  /** A new session: nothing of it was received yet. */
  reset(): void {
    this.pause()
    this.count = 0
  }
}
