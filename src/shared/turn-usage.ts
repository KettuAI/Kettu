// Per-turn cost and per-model token breakdown, stored on `turn_end` entries and shared by
// the agent host and renderer.

import type { AgentAccount, PlanLimit } from './agent-host'
import { harnessOf, type AgentId } from './agents'

/** Per-model token and cost breakdown for one completed turn. */
export interface TurnModelUsage {
  /** Normalized model identifier (e.g. `claude-sonnet-4-6`); empty string when unknown. */
  model: string
  /** Uncached input tokens neither read from nor written to the prompt cache. */
  input: number
  /** Output tokens; excludes `reasoning` only for harnesses that report reasoning separately. */
  output: number
  /** Reasoning tokens reported separately from output; omitted or 0 when already included. */
  reasoning?: number
  /** Input tokens served from the prompt cache. */
  cacheRead: number
  /** Input tokens written into the prompt cache. */
  cacheWrite: number
  /** USD cost for this model at API prices, or null when the model has no known price. */
  costUsd: number | null
}

/** Aggregated per-model token and cost details for a completed turn. */
export interface TurnUsage {
  /** One entry per distinct model used during the turn. */
  models: TurnModelUsage[]
  /**
   * Total USD cost across priced models in this turn, or null when no model has a known price.
   * When some models are priced and others are not, this sums the priced models and `partialCost` is true.
   */
  costUsd: number | null
  /** Set when some models in the turn were priced while at least one model had no known price. */
  partialCost?: true
  /**
   * Whether the turn ran on a subscription account, making API-priced cost an estimate rather
   * than a billed charge. Omitted when unknown (e.g. hydrated from legacy usage rows).
   */
  subscription?: boolean
  /** Date of the API price list used to compute costs (YYYY-MM-DD), when priced from the table. */
  pricesAsOf?: string
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Validates a single per-model usage item from stored or wire data. */
export function isTurnModelUsage(value: unknown): value is TurnModelUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    typeof raw.model === 'string' &&
    isNonNegativeFinite(raw.input) &&
    isNonNegativeFinite(raw.output) &&
    (raw.reasoning === undefined || isNonNegativeFinite(raw.reasoning)) &&
    isNonNegativeFinite(raw.cacheRead) &&
    isNonNegativeFinite(raw.cacheWrite) &&
    (raw.costUsd === null || isNonNegativeFinite(raw.costUsd))
  )
}

/** Validates a `TurnUsage` payload from stored or wire data. */
export function isTurnUsage(value: unknown): value is TurnUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.models) || raw.models.length === 0) return false
  if (!raw.models.every(isTurnModelUsage)) return false
  if (raw.costUsd !== null && !isNonNegativeFinite(raw.costUsd)) return false
  if (raw.partialCost !== undefined && raw.partialCost !== true) return false
  if (raw.subscription !== undefined && typeof raw.subscription !== 'boolean') return false
  if (raw.pricesAsOf !== undefined && typeof raw.pricesAsOf !== 'string') return false
  return true
}

/** Total tokens for a single model row, counting separate reasoning tokens when present. */
export function turnModelTotalTokens(
  model: Pick<TurnModelUsage, 'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite'>,
): number {
  return model.input + model.output + (model.reasoning ?? 0) + model.cacheRead + model.cacheWrite
}

/** Total input tokens (uncached + cache read + cache write) for a single model row. */
export function turnModelTotalInput(
  model: Pick<TurnModelUsage, 'input' | 'cacheRead' | 'cacheWrite'>,
): number {
  return model.input + model.cacheRead + model.cacheWrite
}

/**
 * Prompt cache hit rate for a single model row: `cacheRead / (input + cacheRead + cacheWrite)`.
 * Matches the formula used across Kettu's Usage page and prompt cache checks; returns null when
 * total input is zero.
 */
export function turnModelCacheHitRate(
  model: Pick<TurnModelUsage, 'input' | 'cacheRead' | 'cacheWrite'>,
): number | null {
  const totalInput = turnModelTotalInput(model)
  return totalInput > 0 ? model.cacheRead / totalInput : null
}

/** Aggregated token totals across all models in a turn. */
export interface TurnUsageTotals {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  totalInput: number
  cacheHitRate: number | null
}

/** Sums token counts and computes the overall prompt cache hit rate across all models in a turn. */
export function summarizeTurnUsage(usage: Pick<TurnUsage, 'models'>): TurnUsageTotals {
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  for (const model of usage.models) {
    input += model.input
    output += model.output
    reasoning += model.reasoning ?? 0
    cacheRead += model.cacheRead
    cacheWrite += model.cacheWrite
  }
  const totalInput = input + cacheRead + cacheWrite
  const totalTokens = input + output + reasoning + cacheRead + cacheWrite
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    totalTokens,
    totalInput,
    cacheHitRate: totalInput > 0 ? cacheRead / totalInput : null,
  }
}

/**
 * Determines whether an agent is billed via a subscription plan rather than pay-per-use API rates.
 * DeepSeek platform accounts are pay-as-you-go balances rather than fixed-price subscriptions.
 * Returns `undefined` when billing type cannot be determined.
 */
export function isSubscriptionAccount(
  agentId: AgentId,
  account: Pick<AgentAccount, 'kind'> | null | undefined,
  limits?: readonly Pick<PlanLimit, 'window'>[] | null,
): boolean | undefined {
  if (account && account.kind !== 'none') {
    if (account.kind === 'account') {
      return harnessOf(agentId) !== 'deepseek'
    }
    return false
  }
  if (limits && limits.length > 0) return true
  return undefined
}
