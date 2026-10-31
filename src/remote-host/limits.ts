// How many handshakes direct connections may start: per source address, in total, and at once.
// Connections a port forwarder such as frp passes on all share its address, so the total and the
// cap at once hold them back as well.

/** Handshakes one source may start in a row, then one every 6 s: retries and a few devices fit. */
export const SOURCE_BURST = 10
export const SOURCE_REFILL_MS = 6_000

/** Handshakes all sources may start in a row, then one every 2 s, which bounds a scan's work. */
export const TOTAL_BURST = 30
export const TOTAL_REFILL_MS = 2_000

/** Handshakes waiting at once; one that never finishes holds its slot only until the hello timeout. */
export const MAX_IN_FLIGHT = 16

interface Bucket {
  tokens: number
  at: number
}

export interface HandshakeLimitsOptions {
  /** Milliseconds on a clock that only goes forward. */
  now?: () => number
}

/** Token buckets for the handshakes of direct connections. */
export class HandshakeLimits {
  private readonly sources = new Map<string, Bucket>()
  private total: Bucket
  private waiting = 0
  private readonly now: () => number

  constructor(options: HandshakeLimitsOptions = {}) {
    this.now = options.now ?? (() => performance.now())
    this.total = { tokens: TOTAL_BURST, at: this.now() }
  }

  /** Handshakes admitted and not yet settled. */
  get inFlight(): number {
    return this.waiting
  }

  /**
   * Admits a handshake from `address`, or returns null when a limit holds it back. The function
   * it returns settles the handshake; calling it again does nothing.
   */
  admit(address: string): (() => void) | null {
    if (this.waiting >= MAX_IN_FLIGHT) return null
    const now = this.now()
    const source = sourceOf(address)
    const own = this.sources.get(source)
    const ownTokens = own ? level(own, SOURCE_BURST, SOURCE_REFILL_MS, now) : SOURCE_BURST
    const totalTokens = level(this.total, TOTAL_BURST, TOTAL_REFILL_MS, now)
    if (ownTokens < 1 || totalTokens < 1) return null
    this.total = { tokens: totalTokens - 1, at: now }
    this.sources.set(source, { tokens: ownTokens - 1, at: now })
    this.forgetFull(now)
    this.waiting++
    let settled = false
    return () => {
      if (settled) return
      settled = true
      this.waiting--
    }
  }

  /** Drops the sources whose bucket is full again, so the map holds only recent ones. */
  private forgetFull(now: number): void {
    for (const [source, bucket] of this.sources) {
      if (level(bucket, SOURCE_BURST, SOURCE_REFILL_MS, now) >= SOURCE_BURST) {
        this.sources.delete(source)
      }
    }
  }
}

function level(bucket: Bucket, burst: number, refillMs: number, now: number): number {
  return Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) / refillMs)
}

/**
 * What one source is: an IPv4 address, also when it comes mapped into IPv6, or the /64 of an
 * IPv6 address, since one computer can take any address in its /64.
 */
export function sourceOf(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return mapped[1]!
  if (!address.includes(':')) return address
  const [head = '', tail] = address.split('%')[0]!.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const zeros = Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0')
  const groups = tail === undefined ? left : [...left, ...zeros, ...right]
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`
}
