// Keeps the remote host holding fresh tokens of the account this computer is signed in to, while
// it may use the relay: the access token, which the push gateway takes, and, once the main relay
// takes them, a relay token for the relays in its place, which can do nothing else and lapses
// within the hour. Both are refreshed before they stop being used and gone once signed out. The
// renderer never sees either.

import { parseRelayInfo, relayInfoPath } from '@shared/remote/relay'

/** Tried again this soon after a token could not be had, as without the network. */
const RETRY_MS = 60_000
/** Never sooner than this between two reads, whatever the expiry says. */
const MIN_WAIT_MS = 30_000
/** A relay token is renewed once less than this is left of it. */
export const RELAY_TOKEN_RENEW_MS = 10 * 60_000

export interface Expiring {
  token: string
  expiresAt: number
}

export interface RelayTokenOptions {
  /** A fresh access token and when to stop using it; null while signed out or when none can be had. */
  current(): Promise<Expiring | null>
  /**
   * A relay token for the access token, when the main relay takes them; null when it does not,
   * so the relays get the access token as before. Rejects when one cannot be had now.
   */
  exchange?(accessToken: string): Promise<Expiring | null>
  /** Whether this computer is signed in now. */
  signedIn(): boolean
  /** Whether anything uses the relay now: remote access, or a host reached through it. */
  needed(): boolean
  /** The tokens to hand on: both null once signed out; `relay` null where the relays take none. */
  send(token: string | null, relay: string | null): void
  now?: () => number
}

/** How long reading what the main relay offers may take. */
const FEATURES_TIMEOUT_MS = 15_000

/** What the main relay at `origin` offers, as its `GET /v1` says; rejects when it cannot say. */
export async function readRelayFeatures(origin: string): Promise<string[]> {
  const response = await fetch(`${origin}${relayInfoPath()}`, {
    signal: AbortSignal.timeout(FEATURES_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`it answered ${response.status}`)
  const info = parseRelayInfo(await response.json())
  if (!info) throw new Error('it is not a Kettu relay of this protocol')
  return info.features
}

/** How long what the main relay offers is taken as read. */
const FEATURES_MS = 10 * 60_000

/**
 * Whether the main relay offers a feature, read again at most every 10 minutes; while it cannot
 * be read, the last answer, none at first.
 */
export class RelayFeatures {
  private features: string[] = []
  private readAt = -Infinity
  private reading: Promise<void> | null = null

  constructor(
    private readonly read: () => Promise<string[]>,
    private readonly now: () => number = Date.now,
  ) {}

  async has(feature: string): Promise<boolean> {
    if (this.now() - this.readAt >= FEATURES_MS) {
      this.reading ??= this.read()
        .then((features) => {
          this.features = features
          this.readAt = this.now()
        })
        .catch(() => {})
        .finally(() => {
          this.reading = null
        })
      await this.reading
    }
    return this.features.includes(feature)
  }
}

export class RelayToken {
  private timer: ReturnType<typeof setTimeout> | null = null
  private reading: Promise<void> | null = null
  private stopped = false
  /** The relay token sent last. */
  private relay: Expiring | null = null

  constructor(private readonly options: RelayTokenOptions) {}

  /** The sign-in or what uses the relay changed: reads tokens now, or hands on none. */
  update(): void {
    if (this.stopped) return
    if (!this.options.signedIn() || !this.options.needed()) {
      this.clear()
      this.relay = null
      this.options.send(null, null)
      return
    }
    if (!this.timer && !this.reading) void this.read()
  }

  /** Like `update`, resolving once the tokens were handed on, or none can be had now. */
  ready(): Promise<void> {
    this.update()
    return this.reading ?? Promise.resolve()
  }

  stop(): void {
    this.stopped = true
    this.clear()
  }

  private read(): Promise<void> {
    this.clear()
    this.reading = (async () => {
      const access = await this.options.current().catch(() => null)
      let relay: Expiring | null = null
      let failed = false
      if (access && this.options.exchange) {
        relay = await this.options.exchange(access.token).catch(() => {
          failed = true
          return null
        })
      }
      this.reading = null
      if (this.stopped) return
      if (!access) {
        this.relay = null
        // Signed out meanwhile, or the service could not be reached: none until it can.
        if (!this.options.signedIn()) return this.options.send(null, null)
        return this.schedule(RETRY_MS)
      }
      const now = (this.options.now ?? Date.now)()
      // Without a new relay token, the one sent before while it lasts; else the access token,
      // which the main relay alone still takes.
      if (failed && this.relay && this.relay.expiresAt - now > MIN_WAIT_MS) relay = this.relay
      this.relay = relay
      this.options.send(access.token, relay?.token ?? null)
      const renew = Math.min(
        access.expiresAt - now,
        relay ? relay.expiresAt - RELAY_TOKEN_RENEW_MS - now : Infinity,
      )
      this.schedule(failed ? RETRY_MS : Math.max(MIN_WAIT_MS, renew))
    })()
    return this.reading
  }

  private schedule(ms: number): void {
    this.clear()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.read()
    }, ms)
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
