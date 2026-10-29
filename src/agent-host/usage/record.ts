// Kettu's own record: a turn's rows, one per model, from what its agent reported.

import type { AgentId, TokenTotals } from '@shared/thread'
import type { ModelTokens } from '../acp/mapper'
import { normalizeModel, type UsageRow } from './model'

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
