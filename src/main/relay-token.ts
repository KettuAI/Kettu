// Keeps the remote host holding a fresh access token of the account this computer is signed in
// to, while it may use the relay: refreshed before it stops being used, gone once signed out.
// The renderer never sees it.

/** Tried again this soon after a token could not be had, as without the network. */
const RETRY_MS = 60_000
/** Never sooner than this between two reads, whatever the expiry says. */
const MIN_WAIT_MS = 30_000

export interface RelayTokenOptions {
  /** A fresh token and when to stop using it; null while signed out or when none can be had. */
  current(): Promise<{ token: string; expiresAt: number } | null>
  /** Whether this computer is signed in now. */
  signedIn(): boolean
  /** Whether anything uses the relay now: remote access, or a host reached through it. */
  needed(): boolean
  /** The token to hand on, or null. */
  send(token: string | null): void
  now?: () => number
}

export class RelayToken {
  private timer: ReturnType<typeof setTimeout> | null = null
  private reading: Promise<void> | null = null
  private stopped = false

  constructor(private readonly options: RelayTokenOptions) {}

  /** The sign-in or what uses the relay changed: reads a token now, or hands on none. */
  update(): void {
    if (this.stopped) return
    if (!this.options.signedIn() || !this.options.needed()) {
      this.clear()
      this.options.send(null)
      return
    }
    if (!this.timer && !this.reading) void this.read()
  }

  stop(): void {
    this.stopped = true
    this.clear()
  }

  private read(): Promise<void> {
    this.clear()
    this.reading = (async () => {
      const current = await this.options.current().catch(() => null)
      this.reading = null
      if (this.stopped) return
      if (!current) {
        // Signed out meanwhile, or the service could not be reached: none until it can.
        if (!this.options.signedIn()) return this.options.send(null)
        return this.schedule(RETRY_MS)
      }
      this.options.send(current.token)
      const now = (this.options.now ?? Date.now)()
      this.schedule(Math.max(MIN_WAIT_MS, current.expiresAt - now))
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
