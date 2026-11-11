// Tiers: the agent each tier stands for, the user's choice or the host's pick when none is set.

import { isAgentId } from '@shared/agents'
import {
  TASK_TIERS,
  type TaskTier,
  type TierChoice,
  type TierSettings,
  type TierState,
} from '@shared/tasks'
import type { TaskAgent } from './api'

const MAX_OPTIONS = 10
const OPTION_CHARS = 200

// Claude Code takes its model aliases; Codex's model ids change too often to name, so its tiers
// keep its default model and differ by reasoning effort.
const DEFAULT_OPTIONS: Record<string, Record<TaskTier, TierChoice['options']>> = {
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

export function emptyTiers(): TierSettings {
  return { deep: null, standard: null, fast: null }
}

function usable(agent: TaskAgent | undefined): agent is TaskAgent {
  return agent !== undefined && agent.enabled && agent.canRunNodes
}

/** The host's pick for a tier: the first usable agent, Claude Code before Codex before others. */
function hostPick(tier: TaskTier, agents: readonly TaskAgent[]): TierChoice | null {
  const order = Object.keys(DEFAULT_OPTIONS)
  const rank = (agent: TaskAgent): number => {
    const at = order.indexOf(agent.harness)
    return at < 0 ? order.length : at
  }
  const agent = agents.filter(usable).sort((a, b) => rank(a) - rank(b))[0]
  if (!agent) return null
  const options = DEFAULT_OPTIONS[agent.harness]?.[tier] ?? []
  return { agentId: agent.agentId, options: options.map((option) => ({ ...option })) }
}

/**
 * The agent a tier stands for now. The user's choice is never replaced: when its agent is
 * missing, disabled or may not run nodes, the tier has no agent.
 */
export function tierAgent(
  settings: TierSettings,
  tier: TaskTier,
  agents: readonly TaskAgent[],
): TierChoice | null {
  const choice = settings[tier]
  if (choice === null) return hostPick(tier, agents)
  return usable(agents.find((agent) => agent.agentId === choice.agentId)) ? choice : null
}

export function tierState(settings: TierSettings, agents: readonly TaskAgent[]): TierState {
  const state = {} as TierState['agents']
  for (const tier of TASK_TIERS) {
    const choice = tierAgent(settings, tier, agents)
    const model = choice?.options.find((option) => option.id === 'model')?.value
    state[tier] = choice && {
      agentId: choice.agentId,
      model: typeof model === 'string' ? model : null,
    }
  }
  return { settings: structuredClone(settings), agents: state }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads tier settings from a client or the file; a string says what is wrong. */
export function parseTierSettings(value: unknown): TierSettings | string {
  if (!isRecord(value)) return 'tiers is not an object'
  const tiers = emptyTiers()
  for (const tier of TASK_TIERS) {
    const item = value[tier]
    if (item === null || item === undefined) continue
    if (!isRecord(item) || !isAgentId(item.agentId) || !Array.isArray(item.options)) {
      return `${tier} is malformed`
    }
    if (item.options.length > MAX_OPTIONS) return `${tier} has too many options`
    const options: TierChoice['options'] = []
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
        return `${tier} has a malformed option`
      }
      options.push({ id: option.id, value: option.value })
    }
    tiers[tier] = { agentId: item.agentId, options }
  }
  return tiers
}
