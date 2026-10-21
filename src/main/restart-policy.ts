export interface RestartPolicyOptions {
  initialDelayMs: number
  maxDelayMs: number
  healthyAfterMs: number // running this long resets the delay
  maxCrashes: number // this many crashes within crashWindowMs stops restarting
  crashWindowMs: number
}

export const DEFAULT_RESTART_POLICY: RestartPolicyOptions = {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  healthyAfterMs: 60_000,
  maxCrashes: 5,
  crashWindowMs: 120_000,
}

export type RestartDecision = { kind: 'restart'; delayMs: number } | { kind: 'give-up' }

/** Backoff for a supervised process: 0.5 s, 1 s, 2 s, doubling to 30 s, with a crash budget. */
export class RestartPolicy {
  private attempt = 0
  private crashes: number[] = []
  private healthySince: number | null = null

  constructor(private readonly options: RestartPolicyOptions = DEFAULT_RESTART_POLICY) {}

  /** The process finished its handshake and counts as running from now. */
  ready(now: number): void {
    this.healthySince = now
  }

  crashed(now: number): RestartDecision {
    const { initialDelayMs, maxDelayMs, healthyAfterMs, maxCrashes, crashWindowMs } = this.options
    if (this.healthySince !== null && now - this.healthySince >= healthyAfterMs) this.attempt = 0
    this.healthySince = null
    this.crashes = this.crashes.filter((at) => now - at < crashWindowMs)
    this.crashes.push(now)
    if (this.crashes.length >= maxCrashes) return { kind: 'give-up' }
    const delayMs = Math.min(initialDelayMs * 2 ** this.attempt, maxDelayMs)
    this.attempt++
    return { kind: 'restart', delayMs }
  }

  /** Forgets every crash, for a restart the user asked for. */
  reset(): void {
    this.attempt = 0
    this.crashes = []
    this.healthySince = null
  }
}
