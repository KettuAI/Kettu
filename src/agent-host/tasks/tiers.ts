// Capability tiers: the user's ordered candidates per tier, the defaults when they saved none, and
// the pick at dispatch.

import type { PlanLimit } from '@shared/agent-host'
import { isAgentId } from '@shared/agents'
import { TASK_TIERS, type TaskTier, type TierCandidate, type TierSettings } from '@shared/tasks'
import type { TaskAgent } from './api'

/** A plan-limit window this many percent used, or reached, keeps its agent from new stages. */
export const NEAR_LIMIT_PERCENT = 90

const MAX_CANDIDATES = 20
const MAX_OPTIONS = 10
const OPTION_CHARS = 200

/** The tier one step stronger, `deep` staying `deep`. */
export function stepUp(tier: TaskTier, steps: number): TaskTier {
  const index = TASK_TIERS.indexOf(tier)
  return TASK_TIERS[Math.max(0, index - Math.max(0, steps))]!
}

export function nearLimit(limits: readonly PlanLimit[], now: number): boolean {
  return limits.some(
    (limit) =>
      (limit.state === 'reached' || (limit.usedPercent ?? 0) >= NEAR_LIMIT_PERCENT) &&
      (limit.resetsAt === null || limit.resetsAt > now),
  )
}

// Claude Code takes its model aliases; Codex's model ids change too often to name, so its tiers
// keep its default model and differ by reasoning effort.
const DEFAULT_OPTIONS: Record<string, Record<TaskTier, TierCandidate['options']>> = {
  'claude-code': {
    deep: [{ id: 'model', value: 'opus' }],
    standard: [],
    fast: [{ id: 'model', value: 'haiku' }],
  },
  codex: {
    deep: [{ id: 'reasoning_effort', value: 'high' }],
    standard: [],
    fast: [{ id: 'reasoning_effort', value: 'low' }],
  },
}

/** The tiers when the user saved none: every agent that can run stages, Claude Code first. */
export function defaultTiers(agents: readonly TaskAgent[]): TierSettings {
  const order = Object.keys(DEFAULT_OPTIONS)
  const usable = agents
    .filter((agent) => agent.canRunStages && order.includes(agent.harness))
    .sort((a, b) => order.indexOf(a.harness) - order.indexOf(b.harness))
  const tiers = {} as TierSettings
  for (const tier of TASK_TIERS) {
    tiers[tier] = usable.map((agent) => ({
      agentId: agent.agentId,
      options: DEFAULT_OPTIONS[agent.harness]![tier].map((option) => ({ ...option })),
    }))
  }
  return tiers
}

export type CandidatePick =
  | { kind: 'ok'; candidate: TierCandidate; agent: TaskAgent }
  /** Some candidate could run but for a plan limit near its end: wait for it. */
  | { kind: 'limit' }
  /** No candidate of the tier can ever run as things are set up. */
  | { kind: 'none' }

/**
 * The first candidate of `tier` whose agent is enabled, may run stages and is not near a plan
 * limit. `avoidHarness` is a preference: a candidate of another harness wins, and when there is
 * none the stage still runs, in a new session of the same harness.
 */
export function pickCandidate(
  tiers: TierSettings,
  tier: TaskTier,
  agents: readonly TaskAgent[],
  avoidHarness: string | null,
  now: number,
): CandidatePick {
  let limited = false
  const usable: { candidate: TierCandidate; agent: TaskAgent }[] = []
  for (const candidate of tiers[tier]) {
    const agent = agents.find((a) => a.agentId === candidate.agentId)
    if (!agent || !agent.enabled || !agent.canRunStages) continue
    if (nearLimit(agent.limits, now)) {
      limited = true
      continue
    }
    usable.push({ candidate, agent })
  }
  const pick = usable.find((u) => u.agent.harness !== avoidHarness) ?? usable[0]
  if (pick) return { kind: 'ok', ...pick }
  return limited ? { kind: 'limit' } : { kind: 'none' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads tier settings from a client or the file; a string says what is wrong. */
export function parseTierSettings(value: unknown): TierSettings | string {
  if (!isRecord(value)) return 'tiers is not an object'
  const tiers = {} as TierSettings
  for (const tier of TASK_TIERS) {
    const list = value[tier]
    if (!Array.isArray(list)) return `${tier} is not a list`
    if (list.length > MAX_CANDIDATES) return `${tier} has more than ${MAX_CANDIDATES} candidates`
    const candidates: TierCandidate[] = []
    for (const [index, item] of list.entries()) {
      if (!isRecord(item) || !isAgentId(item.agentId) || !Array.isArray(item.options)) {
        return `${tier} candidate ${index} is malformed`
      }
      if (item.options.length > MAX_OPTIONS)
        return `${tier} candidate ${index} has too many options`
      const options: TierCandidate['options'] = []
      for (const option of item.options) {
        if (
          !isRecord(option) ||
          typeof option.id !== 'string' ||
          option.id.length === 0 ||
          option.id.length > OPTION_CHARS ||
          !(
            typeof option.value === 'boolean' ||
            (typeof option.value === 'string' && option.value.length <= OPTION_CHARS)
          )
        ) {
          return `${tier} candidate ${index} has a malformed option`
        }
        options.push({ id: option.id, value: option.value })
      }
      candidates.push({ agentId: item.agentId, options })
    }
    tiers[tier] = candidates
  }
  return tiers
}
