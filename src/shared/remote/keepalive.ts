// Keeping a connection's channel alive, from protocol version 3: a side that has heard nothing for
// a while asks with `ping`, the other answers `pong`, and silence after a ping ends the connection,
// which then drops as any other does. Both belong to the connection, not to the device session, so
// neither is counted, kept for resuming or acknowledged.

/** The first version whose sides answer `ping` with `pong`. */
export const KEEPALIVE_VERSION = 3

/** Asks the other side to answer, after a quiet spell. */
export interface Ping {
  type: 'ping'
}

/** The answer to a ping. */
export interface Pong {
  type: 'pong'
}

export interface KeepaliveTimings {
  /** How long a side hears nothing before it pings. */
  quietMs: number
  /** How long it then waits for anything before it gives the connection up. */
  answerMs: number
}

/**
 * A device pings first, so on an idle connection one ping about every 10 s, and its answer, are all
 * that moves; the host pings only when its device has gone quiet longer.
 */
export const DEVICE_KEEPALIVE: KeepaliveTimings = { quietMs: 10_000, answerMs: 5_000 }
export const HOST_KEEPALIVE: KeepaliveTimings = { quietMs: 15_000, answerMs: 5_000 }

/** Whether `value` is a ping or a pong, which only the connection reads. */
export function keepaliveMessage(value: unknown): 'ping' | 'pong' | null {
  const type = (value as { type?: unknown } | null)?.type
  return type === 'ping' || type === 'pong' ? type : null
}

export interface KeepaliveOptions extends KeepaliveTimings {
  ping(): void
  /** Nothing came within `answerMs` of a ping: the connection is to be ended. */
  silent(): void
  now?: () => number
}

/**
 * Watches one connection. Hearing something only notes the time, so a busy connection costs no
 * timer; the one timer checks what was heard since the ping, so a timer that fires late, as in a
 * background tab, can only notice a silence later, never end a connection that answered.
 */
export class Keepalive {
  private heardAt: number
  private pingedAt: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly options: KeepaliveOptions) {
    this.heardAt = this.now()
    this.schedule(options.quietMs)
  }

  /** Something came from the other side. */
  heard(): void {
    this.heardAt = this.now()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => this.check(), Math.max(0, ms))
  }

  private check(): void {
    this.timer = null
    if (this.stopped) return
    const { quietMs, answerMs } = this.options
    const now = this.now()
    if (this.pingedAt !== null) {
      if (this.heardAt >= this.pingedAt) this.pingedAt = null
      else if (now - this.pingedAt >= answerMs) return this.options.silent()
      else return this.schedule(this.pingedAt + answerMs - now)
    }
    const quiet = now - this.heardAt
    if (quiet < quietMs) return this.schedule(quietMs - quiet)
    this.pingedAt = now
    this.options.ping()
    this.schedule(answerMs)
  }
}
