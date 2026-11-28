// Kettu's own record: a turn's rows, one per model, from what its agent reported.

import type { AgentId, TokenTotals, TurnModelUsage, TurnUsage } from '@shared/thread'
import { turnModelTotalTokens } from '@shared/turn-usage'
import type { ModelTokens } from '../connection'
import { estimateRowCost, normalizeModel, PRICES, type UsageRow } from './model'

/** Agents whose output leaves the reasoning out, so the total adds it (OpenCode's own does). */
const REASONING_APART: ReadonlySet<AgentId> = new Set(['opencode'])

export interface RecordedTurn {
  /** Kettu's session id. */
  sessionId: string
  acpSessionId: string
  agentId: AgentId
  project: string | null
  /** The turn's `turn_end` entry, which makes the key unique. */
  turnEntryId: string
  at: number
  tokens: TokenTotals | null
  /** `_meta.quota.model_usage`; preferred, since it counts Claude Code's subagents. */
  models: ModelTokens[]
  /** The session's model at the turn's end, for an agent that names none per turn. */
  model: string | null
}

export function recordRows(turn: RecordedTurn): UsageRow[] {
  const reported: ModelTokens[] =
    turn.models.length > 0
      ? turn.models
      : turn.tokens
        ? [{ model: turn.model ?? '', tokens: turn.tokens }]
        : []
  const apart = REASONING_APART.has(turn.agentId)
  const rows = new Map<string, UsageRow>()
  for (const { model: name, tokens } of reported) {
    const model = normalizeModel(name)
    const key = `ob:${turn.sessionId}:${turn.turnEntryId}:${model}`
    const row = rows.get(key) ?? {
      key,
      source: 'kettu' as const,
      agentId: turn.agentId,
      sessionId: turn.acpSessionId,
      project: turn.project,
      model,
      at: turn.at,
      input: 0,
      output: 0,
      reasoning: apart ? 0 : null,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      turn: 0,
    }
    row.input += tokens.input
    row.output += tokens.output
    if (row.reasoning !== null) row.reasoning += tokens.thought ?? 0
    row.cacheRead += tokens.cacheRead ?? 0
    row.cacheWrite += tokens.cacheWrite ?? 0
    rows.set(key, row)
  }
  const recorded = [...rows.values()].filter(
    (row) => row.input + row.output + (row.reasoning ?? 0) + row.cacheRead + row.cacheWrite > 0,
  )
  // The page counts turns by one row each; the models of a turn share its time and key prefix.
  if (recorded[0]) recorded[0].turn = 1
  return recorded
}

/**
 * Extracts `turnEntryId` from a Kettu usage key (`ob:<sessionId>:<turnEntryId>:<model>`) using
 * the stored model column so colons inside entry IDs (e.g. `e:4`) or model names remain intact.
 */
export function parseTurnEntryId(key: string, sessionId: string, model: string): string | null {
  const prefix = `ob:${sessionId}:`
  const suffix = `:${model}`
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null
  if (key.length <= prefix.length + suffix.length) return null
  return key.slice(prefix.length, key.length - suffix.length)
}

type TurnCostRow = Pick<
  UsageRow,
  'model' | 'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h' | 'cost'
>

/**
 * Builds a `TurnUsage` summary from per-model usage rows for one turn, grouping duplicate models,
 * computing per-model and total API-priced costs, and returning null when no tokens were used.
 */
export function buildTurnUsage(
  rows: readonly TurnCostRow[],
  options?: { subscription?: boolean },
): TurnUsage | null {
  const grouped = new Map<
    string,
    {
      model: string
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
      cacheWrite1h: number
      costUsd: number | null
      hasUnpriced: boolean
      fromPriceList: boolean
    }
  >()
  for (const row of rows) {
    const reasoning = row.reasoning ?? 0
    const total = row.input + row.output + reasoning + row.cacheRead + row.cacheWrite
    if (total <= 0) continue
    const estimated = estimateRowCost(row)
    const existing = grouped.get(row.model)
    if (!existing) {
      grouped.set(row.model, {
        model: row.model,
        input: row.input,
        output: row.output,
        reasoning,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        cacheWrite1h: row.cacheWrite1h,
        costUsd: estimated.costUsd,
        hasUnpriced: estimated.costUsd === null,
        fromPriceList: estimated.fromPriceList,
      })
      continue
    }
    existing.input += row.input
    existing.output += row.output
    existing.reasoning += reasoning
    existing.cacheRead += row.cacheRead
    existing.cacheWrite += row.cacheWrite
    existing.cacheWrite1h += row.cacheWrite1h
    if (estimated.costUsd === null) {
      existing.hasUnpriced = true
    } else {
      existing.costUsd = (existing.costUsd ?? 0) + estimated.costUsd
      if (estimated.fromPriceList) existing.fromPriceList = true
    }
  }
  if (grouped.size === 0) return null

  let totalCost: number | null = null
  let hasUnpricedModel = false
  let usedPriceList = false
  const models: TurnModelUsage[] = []
  for (const item of grouped.values()) {
    const modelCost = item.costUsd
    if (modelCost === null) {
      hasUnpricedModel = true
    } else {
      totalCost = (totalCost ?? 0) + modelCost
      if (item.hasUnpriced) hasUnpricedModel = true
      if (item.fromPriceList) usedPriceList = true
    }
    models.push({
      model: item.model,
      input: item.input,
      output: item.output,
      ...(item.reasoning > 0 ? { reasoning: item.reasoning } : {}),
      cacheRead: item.cacheRead,
      cacheWrite: item.cacheWrite,
      costUsd: modelCost,
    })
  }
  // Order by cost descending (priced first), breaking ties by total tokens descending.
  models.sort((a, b) => {
    const costDiff = (b.costUsd ?? -1) - (a.costUsd ?? -1)
    if (costDiff !== 0) return costDiff
    const tokenDiff = turnModelTotalTokens(b) - turnModelTotalTokens(a)
    if (tokenDiff !== 0) return tokenDiff
    return a.model.localeCompare(b.model)
  })
  return {
    models,
    costUsd: totalCost,
    ...(totalCost !== null && hasUnpricedModel ? { partialCost: true as const } : {}),
    ...(options?.subscription !== undefined ? { subscription: options.subscription } : {}),
    ...(usedPriceList ? { pricesAsOf: PRICES.asOf } : {}),
  }
}
