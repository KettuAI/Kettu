// How fast the model writes in a session: one reading per request of the main thread. A request
// whose output streamed is timed from its first output to its end; one whose output did not show
// until it was whole, through a buffering proxy or an agent that reports only finished messages,
// is timed from when it was sent, waiting included, and shown as approximate.

/** Fewer output tokens than this say nothing about speed, such as a request that only calls a tool. */
export const SPEED_MIN_TOKENS = 50
/** Output that arrived in less time than this came at once, so it times nothing. */
export const SPEED_MIN_MS = 500
/** How many of the latest readings the session keeps, for their bars. */
export const SPEED_RECENT = 12

export interface SpeedTotals {
  tokens: number
  ms: number
  requests: number
  /** How many of them were timed from when they were sent. */
  approx: number
}

/** One request of the main thread, timed on the host. */
export interface SpeedSample {
  /** Output tokens, thinking included. */
  tokens: number
  /** From its first output to its end, or from when it was sent when `approx`. */
  ms: number
  /** Timed from when it was sent, since its output did not show as it was written. */
  approx: boolean
  /** From when it was sent to its first output; null when that is not known. */
  firstTokenMs: number | null
}

export interface SpeedReading {
  rate: number
  approx: boolean
}

export interface OutputSpeed {
  last: SpeedSample
  /** The latest readings, oldest first, at most `SPEED_RECENT`. */
  recent: SpeedReading[]
  /** The readings of the turn that started at `since`, the session's `turnStartedAt`. */
  turn: SpeedTotals & { since: number | null }
  session: SpeedTotals
}

export function tokensPerSecond(tokens: number, ms: number): number {
  return ms > 0 ? (tokens * 1000) / ms : 0
}

/**
 * A request timed both ways where it can be: from its first output when its output streamed over
 * at least `SPEED_MIN_MS`, else from when it was sent. Null when neither can be timed.
 */
export function timeRequest(
  tokens: number,
  sentAt: number | null,
  firstOutputAt: number | null,
  endedAt: number,
): SpeedSample | null {
  if (firstOutputAt !== null && endedAt - firstOutputAt >= SPEED_MIN_MS) {
    return {
      tokens,
      ms: endedAt - firstOutputAt,
      approx: false,
      firstTokenMs: sentAt !== null && sentAt <= firstOutputAt ? firstOutputAt - sentAt : null,
    }
  }
  if (sentAt === null || sentAt > endedAt) return null
  return { tokens, ms: endedAt - sentAt, approx: true, firstTokenMs: null }
}

/** The later of two times, either of which may be unknown. */
export function latestTime(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b)
}

/** The speed with one more request read, or null when the request does not count. */
export function addSpeedSample(
  previous: OutputSpeed | null | undefined,
  sample: SpeedSample,
  turnSince: number | null,
): OutputSpeed | null {
  if (sample.tokens < SPEED_MIN_TOKENS || sample.ms < SPEED_MIN_MS) return null
  const rate = Math.round(tokensPerSecond(sample.tokens, sample.ms) * 10) / 10
  const sameTurn = previous !== null && previous !== undefined && previous.turn.since === turnSince
  const turn = sameTurn ? previous.turn : { since: turnSince, ...EMPTY }
  return {
    last: sample,
    recent: [...(previous?.recent ?? []), { rate, approx: sample.approx }].slice(-SPEED_RECENT),
    turn: add(turn, sample),
    session: add(previous?.session ?? EMPTY, sample),
  }
}

const EMPTY: SpeedTotals = { tokens: 0, ms: 0, requests: 0, approx: 0 }

function add<T extends SpeedTotals>(totals: T, sample: SpeedSample): T {
  return {
    ...totals,
    tokens: totals.tokens + sample.tokens,
    ms: totals.ms + sample.ms,
    requests: totals.requests + 1,
    approx: totals.approx + (sample.approx ? 1 : 0),
  }
}
