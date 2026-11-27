// When a session's prompt cache expires: from the lifetime the agent's own transcript gives,
// else estimated from the shortest retention the agent's provider documents for its model.

import type { AgentAccount } from './agent-host'
import type { LastRequest } from './model-requests'
import {
  harnessOf,
  type AgentId,
  type ConfigOption,
  type PromptCache,
  type SessionView,
} from './thread'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** Below this many tokens read again, an expired cache costs too little to warn about. */
export const CACHE_NOTICE_MIN_TOKENS = 20_000

/** Minimum total input tokens for both baseline and current turns to evaluate a cache hit drop. */
export const CACHE_DROP_MIN_INPUT_TOKENS = CACHE_NOTICE_MIN_TOKENS
/** Minimum baseline hit share required before a later drop counts as a meaningful regression. */
export const CACHE_DROP_MIN_BASELINE_SHARE = 0.5
/** Minimum absolute drop in hit share (25 percentage points) required to surface a notice. */
export const CACHE_DROP_MIN_SHARE_DROP = 0.25
/** Minimum lost cache-read tokens relative to the baseline share before surfacing a notice. */
export const CACHE_DROP_MIN_LOST_TOKENS = 10_000
/** Minimum extra API-priced USD cost before displaying an extra-cost figure. */
export const CACHE_DROP_MIN_EXTRA_COST_USD = 0.01
/**
 * When a single-request turn reads at least this share of the previous turn's entire input from
 * cache (and at least as many cached tokens as before), the lower share reflects a large new input
 * rather than lost cached prefix.
 */
const DILUTION_CARRY_SHARE = 0.85

/**
 * A confirmed reason for a prompt cache hit drop, set only when Kettu observed the cause directly.
 * Left null whenever no verifiable cause is known.
 */
export type CacheDropReason = 'model_changed' | 'compacted' | 'expired'

/** Measured cache-hit sample for a completed turn. */
export interface CacheSample {
  /** Uncached input tokens neither read from nor written to the prompt cache. */
  input: number
  /** Tokens served from the prompt cache. */
  cacheRead: number
  /** Tokens written into the prompt cache, or null when not reported separately. */
  cacheWrite: number | null
  /** Total input tokens: `input + cacheRead + (cacheWrite ?? 0)`. */
  totalInput: number
  /** Measured cache hit share: `cacheRead / totalInput` (0..1). */
  share: number
  /** Normalized model id for the turn when known, else null. */
  model: string | null
  /** Timestamp when the turn settled. */
  at: number
}

/** Per-token USD pricing needed to estimate extra cost from a cache hit drop. */
export interface CachePrice {
  input: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h?: number
}

/**
 * Measured prompt cache hit-rate drop observed after a completed turn, compared against the
 * session's previous comparable turn baseline.
 */
export interface PromptCacheDrop {
  /** Timestamp when the turn settled (also used as the dismiss key in the composer). */
  at: number
  /** Measured cache hit share of the previous comparable turn (0..1). */
  baselineShare: number
  /** Measured cache hit share of the completed turn (0..1). */
  currentShare: number
  /** Previous turn's cache-read tokens. */
  baselineCacheRead: number
  /** Current turn's cache-read tokens. */
  currentCacheRead: number
  /** Current turn's total input tokens. */
  currentTotalInput: number
  /** Current turn's non-cached input tokens (`input + (cacheWrite ?? 0)`). */
  missedTokens: number
  /** Verifiable cause directly observed by Kettu; null when not confirmed. */
  reason: CacheDropReason | null
  /**
   * Estimated extra USD cost at API prices compared with keeping the baseline hit share; null when
   * no reliable model price applies or the extra amount is negligible.
   */
  extraCostUsd: number | null
}

/**
 * The shortest time a provider documents keeping a prompt cache after its last use, or null.
 * Checked on 2026-10-24: OpenAI keeps it at least 30 minutes for GPT-5.5 and later, and 5 to 10
 * minutes of inactivity for earlier models; Anthropic 5 minutes unless a request asks for an hour.
 */
function documentedTtl(provider: string | null, model: string | null): number | null {
  if (provider === 'anthropic') return 5 * MINUTE
  if (provider !== 'openai') return null
  return model !== null && isGpt55OrLater(model) ? 30 * MINUTE : 5 * MINUTE
}

/**
 * From the version in the model's name, after OpenCode's provider if any: "gpt-5.6-sol/high",
 * "openai/gpt-6".
 */
function isGpt55OrLater(model: string): boolean {
  const version = /^(?:[^/]+\/)?gpt-(\d+)(?:\.(\d+))?/i.exec(model)
  if (!version) return false
  const major = Number(version[1])
  return major > 5 || (major === 5 && Number(version[2] ?? 0) >= 5)
}

function isClaudeModel(model: string): boolean {
  return /^(?:[^/]+\/)?claude-/i.test(model)
}

export interface CacheExpiry {
  lastRequestAt: number
  /** How long the cache lasts after a request, or null when nothing says. */
  ttl: number | null
  expiresAt: number | null
  /** The lifetime is the provider's documented minimum, not the agent's own. */
  estimate: boolean
}

/** A cache whose lifetime is known, so it has a moment it expires. */
export type KnownExpiry = CacheExpiry & { ttl: number; expiresAt: number }

export interface CacheHit {
  at: number
  cacheRead: number
  cacheWrite: number | null
  uncachedInput: number
  totalInput: number
  share: number
}

export type CachePhase = 'warm' | 'ending' | 'expired'

/** The cache's last minutes, when the session page warns: five of an hour, one of less. */
export function endingWindow(ttl: number): number {
  return ttl >= HOUR ? 5 * MINUTE : MINUTE
}

/**
 * The provider whose retention applies. codex-acp reports a model provider other than OpenAI as a
 * gateway account, and Bedrock as an external one, so Codex is OpenAI only on a ChatGPT account
 * or an OpenAI API key. Antigravity runs Claude models on Anthropic's prompt cache; Gemini uses
 * implicit server-managed caching with no fixed TTL. OpenCode names the provider in the model.
 */
function providerOf(
  agentId: AgentId,
  model: string | null,
  account: AgentAccount | null,
): string | null {
  const harness = harnessOf(agentId)
  if (harness === 'codex') {
    return account?.kind === 'account' || account?.kind === 'api_key' ? 'openai' : null
  }
  if (harness === 'antigravity') {
    return model !== null && isClaudeModel(model) ? 'anthropic' : null
  }
  if (harness !== 'opencode' || model === null) return null
  const slash = model.indexOf('/')
  return slash > 0 ? model.slice(0, slash).toLowerCase() : null
}

/** Cache hit breakdown from a completed request, or null when the request reports none. */
export function cacheHitOf(lastRequest: LastRequest | null | undefined): CacheHit | null {
  if (
    !lastRequest ||
    lastRequest.output === null ||
    lastRequest.input === null ||
    lastRequest.cacheRead === null
  ) {
    return null
  }
  const cacheWrite = lastRequest.cacheWrite
  const totalInput = lastRequest.input + lastRequest.cacheRead + (cacheWrite ?? 0)
  if (totalInput <= 0) return null
  return {
    at: lastRequest.at,
    cacheRead: lastRequest.cacheRead,
    cacheWrite,
    uncachedInput: lastRequest.input,
    totalInput,
    share: lastRequest.cacheRead / totalInput,
  }
}

/** `model` is the session's model option and `account` the one its agent last reported. */
export function expiryOf(
  agentId: AgentId,
  cache: PromptCache | null | undefined,
  model: string | null,
  account: AgentAccount | null,
): CacheExpiry | null {
  if (!cache) return null
  const { lastRequestAt, ttl } = cache
  if (ttl !== null) return { lastRequestAt, ttl, expiresAt: lastRequestAt + ttl, estimate: false }
  const documented = documentedTtl(providerOf(agentId, model, account), model)
  if (documented === null) return { lastRequestAt, ttl: null, expiresAt: null, estimate: false }
  return { lastRequestAt, ttl: documented, expiresAt: lastRequestAt + documented, estimate: true }
}

/** The session's model option, as `expiryOf` takes it. */
export function modelOption(config: readonly ConfigOption[]): string | null {
  const model = config.find((option) => option.category === 'model')?.value
  return typeof model === 'string' ? model : null
}

export function cacheExpiry(
  session: Pick<SessionView, 'agentId' | 'config' | 'usage'>,
  account: AgentAccount | null,
): CacheExpiry | null {
  return expiryOf(session.agentId, session.usage?.cache, modelOption(session.config), account)
}

export function knownExpiry(expiry: CacheExpiry | null): KnownExpiry | null {
  if (!expiry || expiry.ttl === null || expiry.expiresAt === null) return null
  return { ...expiry, ttl: expiry.ttl, expiresAt: expiry.expiresAt }
}

/** `ending` is the cache's `endingWindow`. */
export function cachePhase(expiresAt: number, ending: number, now: number): CachePhase {
  if (now >= expiresAt) return 'expired'
  return expiresAt - now <= ending ? 'ending' : 'warm'
}

/** How long until the phase changes, or null once the cache has expired. */
export function nextPhaseIn(expiresAt: number, ending: number, now: number): number | null {
  const left = expiresAt - now
  if (left <= 0) return null
  return left > ending ? left - ending : left
}

function nonNegativeFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Builds a measured cache sample from turn or request token counts, or null when the data lacks
 * reliable cache-read reporting or positive total input.
 */
export function cacheSampleOf(params: {
  input: number | null | undefined
  cacheRead: number | null | undefined
  cacheWrite: number | null | undefined
  model: string | null
  at: number
}): CacheSample | null {
  const input = nonNegativeFinite(params.input)
  const cacheRead = nonNegativeFinite(params.cacheRead)
  if (input === null || cacheRead === null) return null
  const cacheWrite = params.cacheWrite == null ? null : nonNegativeFinite(params.cacheWrite)
  if (params.cacheWrite != null && cacheWrite === null) return null
  const totalInput = input + cacheRead + (cacheWrite ?? 0)
  if (totalInput <= 0) return null
  return {
    input,
    cacheRead,
    cacheWrite,
    totalInput,
    share: cacheRead / totalInput,
    model: params.model && params.model.trim() !== '' ? params.model : null,
    at: params.at,
  }
}

/**
 * Estimates extra USD cost at API prices from losing cache hits relative to `baselineShare`, or
 * null when the model lacks confirmed cache-discount pricing or the extra amount is negligible.
 */
export function estimateCacheDropExtraCost(params: {
  baselineShare: number
  current: CacheSample
  price: CachePrice | null
  cacheTtlMs: number | null
}): number | null {
  const { baselineShare, current, price, cacheTtlMs } = params
  if (!price || !(price.input > 0) || !(price.cacheRead > 0) || price.cacheRead >= price.input) {
    return null
  }
  const shareDrop = baselineShare - current.share
  if (!(shareDrop > 0)) return null
  const cacheWrite = current.cacheWrite ?? 0
  const missedTokens = current.input + cacheWrite
  if (missedTokens <= 0) return null
  const writePrice =
    cacheWrite > 0
      ? cacheTtlMs !== null &&
        cacheTtlMs >= HOUR &&
        price.cacheWrite1h !== undefined &&
        price.cacheWrite1h > 0
        ? price.cacheWrite1h
        : price.cacheWrite > 0
          ? price.cacheWrite
          : price.input
      : price.input
  const missUnitPrice = (current.input * price.input + cacheWrite * writePrice) / missedTokens
  const deltaUnitPrice = missUnitPrice - price.cacheRead
  if (!(deltaUnitPrice > 0)) return null
  const lostCacheTokens = shareDrop * current.totalInput
  const extra = lostCacheTokens * deltaUnitPrice
  if (!Number.isFinite(extra) || extra < CACHE_DROP_MIN_EXTRA_COST_USD) return null
  return Math.round(extra * 10_000) / 10_000
}

/**
 * Evaluates a completed turn against the prior comparable turn baseline and returns a measured
 * prompt cache hit drop when both turns carry reliable cache data, the drop is material, and it
 * does not duplicate a pre-send known expiry warning.
 */
export function detectCacheDrop(params: {
  baseline: CacheSample | null
  current: CacheSample | null
  /** Pre-send known cache expiry already covered by the existing expiry notice logic. */
  knownExpiredBeforeSend: boolean
  /** Confirmed compaction completed between the baseline and the end of this turn. */
  compacted: boolean
  /** Confirmed mid-turn TTL expiry between requests when cache was still warm before send. */
  expiredMidTurn: boolean
  /** Number of model requests observed during this turn (0 when unknown). */
  requestCount: number
  /** Confirmed API pricing for the current turn's model, or null when unpriced. */
  price: CachePrice | null
  /** Known cache TTL in ms for pricing 1-hour cache writes when applicable. */
  cacheTtlMs: number | null
}): PromptCacheDrop | null {
  const {
    baseline,
    current,
    knownExpiredBeforeSend,
    compacted,
    expiredMidTurn,
    requestCount,
    price,
    cacheTtlMs,
  } = params
  if (!baseline || !current) return null
  if (knownExpiredBeforeSend) return null
  if (
    baseline.totalInput < CACHE_DROP_MIN_INPUT_TOKENS ||
    current.totalInput < CACHE_DROP_MIN_INPUT_TOKENS
  ) {
    return null
  }
  if (baseline.cacheRead <= 0 || baseline.share < CACHE_DROP_MIN_BASELINE_SHARE) return null
  const shareDrop = baseline.share - current.share
  if (shareDrop < CACHE_DROP_MIN_SHARE_DROP) return null
  const lostCacheTokens = Math.round(shareDrop * current.totalInput)
  if (lostCacheTokens < CACHE_DROP_MIN_LOST_TOKENS) return null
  // A single-request turn that still read almost the entire prior context from cache simply added
  // a large new input rather than losing cached prefix.
  if (
    requestCount <= 1 &&
    current.cacheRead >= baseline.cacheRead &&
    current.cacheRead >= baseline.totalInput * DILUTION_CARRY_SHARE
  ) {
    return null
  }
  const modelChanged =
    baseline.model !== null && current.model !== null && baseline.model !== current.model
  const reason: CacheDropReason | null = modelChanged
    ? 'model_changed'
    : compacted
      ? 'compacted'
      : expiredMidTurn
        ? 'expired'
        : null
  const missedTokens = current.input + (current.cacheWrite ?? 0)
  const extraCostUsd = estimateCacheDropExtraCost({
    baselineShare: baseline.share,
    current,
    price,
    cacheTtlMs,
  })
  return {
    at: current.at,
    baselineShare: baseline.share,
    currentShare: current.share,
    baselineCacheRead: baseline.cacheRead,
    currentCacheRead: current.cacheRead,
    currentTotalInput: current.totalInput,
    missedTokens,
    reason,
    extraCostUsd,
  }
}

/** Whether the composer should display the opt-in post-turn prompt cache hit-drop notice. */
export function shouldShowCacheDropNotice(params: {
  enabled: boolean
  drop: PromptCacheDrop | null | undefined
  cacheNoticeShown: boolean
  activeRunning: boolean
  starting: boolean
  pendingSwitch: boolean
  mustSwitch: boolean
  dismissedKey: string | null
  noticeKey: string | null
}): boolean {
  const {
    enabled,
    drop,
    cacheNoticeShown,
    activeRunning,
    starting,
    pendingSwitch,
    mustSwitch,
    dismissedKey,
    noticeKey,
  } = params
  return (
    enabled &&
    drop != null &&
    !cacheNoticeShown &&
    !activeRunning &&
    !starting &&
    !pendingSwitch &&
    !mustSwitch &&
    noticeKey !== null &&
    dismissedKey !== noticeKey
  )
}
