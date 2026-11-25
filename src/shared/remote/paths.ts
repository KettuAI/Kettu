// Ranking the paths a device has to a host: its direct addresses and the relay.
// Each path's round trip is the median of its last few samples, pings on open connections and
// handshakes on candidates; recent failures push a path down, a path without a relay wins when
// round trips are close, and a device moves only to a clearly faster path or off a failing one.

/** Samples a path's round trip is the median of. */
export const PATH_SAMPLES = 5

/** How long a failure counts against a path. */
export const FAILURE_WINDOW_MS = 10 * 60_000

/** Each recent failure doubles a path's round trip for ranking, at most this many times. */
export const MAX_FAILURE_DOUBLINGS = 3

/** A path without a relay ranks first while its round trip is within this factor of a relay's. */
export const NO_RELAY_MARGIN = 1.2

/** A device moves when the best path's round trip is at most this share of the current one's. */
export const MOVE_RATIO = 0.7

/** A ping on the current path over this many times its median makes the device compare again. */
export const SLOW_RATIO = 2

/**
 * The least time from one comparison to the next that a slow ping asks for: about twelve idle
 * pings, so the next comparison goes by a median of fresh samples.
 */
export const SLOW_COMPARE_GAP_MS = 2 * 60_000

/** How long a candidate path has to finish its handshake. */
export const PROBE_TIMEOUT_MS = 4_000

/** A path as ranking knows it: a key that names it, and whether it goes through a relay. */
export interface PathRef {
  key: string
  relay: boolean
}

/** The round trips and failures of each path, by key. */
export class PathTimes {
  private readonly samples = new Map<string, number[]>()
  private readonly failures = new Map<string, number[]>()

  constructor(private readonly now: () => number = Date.now) {}

  /** A round trip measured on `key`; true when it is over SLOW_RATIO times the median before it. */
  sample(key: string, ms: number): boolean {
    if (!Number.isFinite(ms) || ms < 0) return false
    const before = this.rtt(key)
    const kept = this.samples.get(key) ?? []
    kept.push(ms)
    if (kept.length > PATH_SAMPLES) kept.shift()
    this.samples.set(key, kept)
    return before !== null && ms > before * SLOW_RATIO
  }

  /** The path failed or timed out. */
  failed(key: string): void {
    const kept = this.recentFailures(key)
    kept.push(this.now())
    this.failures.set(key, kept)
  }

  /** The median of the path's samples, or null before the first. */
  rtt(key: string): number | null {
    const kept = this.samples.get(key)
    if (!kept || kept.length === 0) return null
    const sorted = [...kept].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  }

  /** What ranks the path: its round trip doubled for each recent failure, or null when unknown. */
  score(path: PathRef): number | null {
    const rtt = this.rtt(path.key)
    if (rtt === null) return null
    const doublings = Math.min(MAX_FAILURE_DOUBLINGS, this.recentFailures(path.key).length)
    const score = rtt * 2 ** doublings
    return path.relay ? score : score / NO_RELAY_MARGIN
  }

  private recentFailures(key: string): number[] {
    const since = this.now() - FAILURE_WINDOW_MS
    const kept = (this.failures.get(key) ?? []).filter((at) => at >= since)
    this.failures.set(key, kept)
    return kept
  }
}

/**
 * When a device compares its paths: once at the soonest time asked, however often it is asked
 * meanwhile. Each comparison opens a handshake on every other path, so where round trips jitter a
 * slow ping waits until SLOW_COMPARE_GAP_MS after the last comparison; nothing else is held back.
 */
export class CompareTimer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private at = 0
  private last: number | null = null

  constructor(private readonly compare: () => void) {}

  /** Compares after `delay` ms, or sooner when already asked to. */
  soon(delay: number): void {
    const at = Date.now() + delay
    if (this.timer && this.at <= at) return
    if (this.timer) clearTimeout(this.timer)
    this.at = at
    this.timer = setTimeout(() => {
      this.timer = null
      this.compare()
    }, delay)
  }

  /** A ping came back far slower than before. */
  slow(): void {
    const last = this.last
    this.soon(last === null ? 0 : Math.max(0, last + SLOW_COMPARE_GAP_MS - Date.now()))
  }

  /** A comparison opens its handshakes now, whatever asked for it. */
  started(): void {
    this.last = Date.now()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** The paths best first; those whose round trip is unknown last, in the order given. */
export function rankPaths<T extends PathRef>(paths: readonly T[], times: PathTimes): T[] {
  return paths
    .map((path, order) => ({ path, order, score: times.score(path) }))
    .sort((a, b) => {
      if (a.score !== null && b.score !== null && a.score !== b.score) return a.score - b.score
      if (a.score === null && b.score !== null) return 1
      if (a.score !== null && b.score === null) return -1
      return a.order - b.order
    })
    .map(({ path }) => path)
}

/** Whether to move from `current` to `best`: off a failing path, or to one clearly faster. */
export function shouldMove(
  current: PathRef,
  best: PathRef,
  times: PathTimes,
  failing: boolean,
): boolean {
  if (best.key === current.key) return false
  if (failing) return true
  const from = times.rtt(current.key)
  const to = times.rtt(best.key)
  if (to === null) return false
  return from === null || to <= from * MOVE_RATIO
}
