// A connection a device keeps beside its session's: the one a move left behind, until the host
// says it is the session's standby, and the standby itself. It carries no session messages, only
// the connection's pings, whose round trips it times, and it can take the session over at once.

import type { DeviceChannel } from './device-channel'
import {
  DEVICE_KEEPALIVE,
  Keepalive,
  keepaliveMessage,
  type KeepaliveTimings,
  type Ping,
  type Pong,
} from './keepalive'
import type { StandbyPromote } from './protocol'

export interface AsideOptions {
  timings?: KeepaliveTimings
  /** A ping's round trip on this connection. */
  rtt?(ms: number): void
  /** The host said this connection is its session's standby. */
  standingBy?(): void
  /** The connection ended, or went silent and was ended, before it took the session over. */
  ended?(): void
}

export class AsideConnection<V = unknown> {
  private standing = false
  private done = false
  private pingedAt: number | null = null
  private readonly keepalive: Keepalive

  constructor(
    readonly channel: DeviceChannel,
    /** How the connection reaches the host, as its link names paths. */
    readonly via: V,
    private readonly options: AsideOptions = {},
  ) {
    this.keepalive = new Keepalive({
      ...(options.timings ?? DEVICE_KEEPALIVE),
      ping: () => {
        this.pingedAt = Date.now()
        this.send({ type: 'ping' } satisfies Ping)
      },
      silent: () => {
        this.channel.close()
        this.end()
      },
    })
    channel.onMessage((value) => this.receive(value))
    channel.onBytes(() => this.keepalive.heard())
    void channel.closed.then(() => this.end())
  }

  /** Open, and the host's standby for the session. */
  get standby(): boolean {
    return this.standing && !this.done
  }

  get open(): boolean {
    return !this.done
  }

  /**
   * Takes the session over on this connection: the host answers with a welcome naming what it
   * read, as for a resuming hello. The channel is the caller's from here on, its next message the
   * host's answer.
   */
  promote(received: number): DeviceChannel {
    this.stop()
    this.channel.send({ type: 'standby.promote', received } satisfies StandbyPromote).catch(() => {
      this.channel.close()
    })
    return this.channel
  }

  close(): void {
    if (this.done) return
    this.stop()
    this.channel.close()
  }

  private receive(value: unknown): void {
    if (this.done) return
    this.keepalive.heard()
    const own = keepaliveMessage(value)
    if (own === 'ping') return this.send({ type: 'pong' } satisfies Pong)
    if (own === 'pong') {
      if (this.pingedAt !== null) this.options.rtt?.(Date.now() - this.pingedAt)
      this.pingedAt = null
      return
    }
    // What the session sent before the host made this the standby is the new connection's now.
    if ((value as { type?: unknown } | null)?.type === 'standby' && !this.standing) {
      this.standing = true
      this.options.standingBy?.()
    }
  }

  private send(value: unknown): void {
    this.channel.send(value).catch(() => this.channel.close())
  }

  private stop(): void {
    this.done = true
    this.keepalive.stop()
  }

  private end(): void {
    if (this.done) return
    this.stop()
    this.options.ended?.()
  }
}
