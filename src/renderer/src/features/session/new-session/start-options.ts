import type { AgentOptions, AgentStatus } from '@shared/agent-host'
import type { AgentId, ConfigOption } from '@shared/thread'
import { listedInstalled, readiness } from '@renderer/features/agents/readiness'
import type { OptionValues } from '@renderer/stores/agent-options'

/**
 * What an agent needs before New session can start it, by the checks Settings › Agents lists it
 * with. `adapter` is a package agent whose adapter is not installed yet, and `install` one missing
 * from the machine: neither can be chosen until Settings › Agents installs it. `setup` is a
 * package agent without its adapter while the user's own CLI is to run: the user installed the
 * agent, so it can be chosen, and its first start installs the adapter without the CLI's copy
 * unless the adapter rejects the CLI's version.
 */
export type AgentNeed = 'install' | 'installing' | 'failed' | 'adapter' | 'setup' | 'sign-in' | null

export function agentNeed(status: AgentStatus): AgentNeed {
  const r = readiness(status)
  if (r.kind === 'missing') return 'install'
  if (r.kind === 'installing') return 'installing'
  if (r.kind === 'failed') return 'failed'
  if (!listedInstalled(status)) {
    return status.cli?.runs === 'installed' ? 'setup' : 'adapter'
  }
  return r.kind === 'sign-in' ? 'sign-in' : null
}

/** Whether New session can start the agent, and so whether its menu lists it. */
export function canStart(status: AgentStatus): boolean {
  const need = agentNeed(status)
  return need !== 'install' && need !== 'adapter'
}

/**
 * While no agent can start, the names of those waiting for Node.js, which installing it fixes;
 * empty when they all need installing. Null once one can start, or while none is known.
 */
export function noAgentCanStart(statuses: AgentStatus[]): string[] | null {
  if (statuses.length === 0 || statuses.some(canStart)) return null
  return statuses
    .filter((s) => s.state === 'node-missing' || s.state === 'node-outdated')
    .map((s) => s.name)
}

// The categories whose last chosen values carry over to the next session, as the host keeps them.
const REMEMBERED: ReadonlySet<ConfigOption['category']> = new Set([
  'model',
  'model_config',
  'thought_level',
])

function takes(option: ConfigOption, value: string | boolean): boolean {
  if (option.type === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string' && !!option.choices?.some((c) => c.value === value)
}

/**
 * The options a new session with the agent starts with: the agent's own defaults, then the values
 * remembered from earlier sessions, then what New session set. A value the option no longer takes
 * is passed over. The level is the one the chosen model offered when last seen, since an agent's
 * levels can differ by model.
 */
export function startConfig(entry: AgentOptions, picks: OptionValues = {}): ConfigOption[] {
  const valueOf = (option: ConfigOption): string | boolean => {
    const pick = picks[option.id]
    if (pick !== undefined && takes(option, pick)) return pick
    const remembered = REMEMBERED.has(option.category) ? entry.remembered[option.id] : undefined
    if (remembered !== undefined && takes(option, remembered)) return remembered
    return option.value
  }
  const model = entry.config.find((o) => o.category === 'model' && o.type === 'select')
  const modelValue = model ? valueOf(model) : null
  return entry.config.map((option) => {
    const base =
      option.category === 'thought_level' && typeof modelValue === 'string'
        ? (entry.levels[modelValue] ?? option)
        : option
    return { ...base, value: valueOf(base) }
  })
}

/**
 * The prepared session's options, as its agent reports them, with what New session set that the
 * agent has not answered yet. While a model is picked, the level is the one that model offered
 * when last seen.
 */
export function preparedConfig(
  config: readonly ConfigOption[],
  levels: Record<string, ConfigOption>,
  picks: OptionValues = {},
): ConfigOption[] {
  const model = config.find((o) => o.category === 'model' && o.type === 'select')
  const modelPick = model ? picks[model.id] : undefined
  const pickedModel = model && modelPick !== undefined && takes(model, modelPick) ? modelPick : null
  return config.map((option) => {
    const base =
      option.category === 'thought_level' && typeof pickedModel === 'string'
        ? (levels[pickedModel] ?? option)
        : option
    const pick = picks[base.id]
    return pick !== undefined && takes(base, pick) ? { ...base, value: pick } : base
  })
}

/**
 * What `sessions.create` takes: the start values that differ from the agent's own defaults, or
 * every value for a provisional entry, whose values need not be the agent's defaults.
 */
export function startValues(entry: AgentOptions, picks: OptionValues = {}): OptionValues {
  const defaults = new Map(entry.provisional ? [] : entry.config.map((o) => [o.id, o.value]))
  const values: OptionValues = {}
  for (const option of startConfig(entry, picks)) {
    if (defaults.get(option.id) !== option.value) values[option.id] = option.value
  }
  return values
}

// An item of the agent menu's list: an agent's model, or the agent with its default model when
// its models are unknown. NUL cannot occur in an agent id or a model value.
const SEPARATOR = '\0'

export function itemKey(agentId: AgentId, model: string | null): string {
  return `${agentId}${SEPARATOR}${model ?? ''}`
}

export function parseItemKey(key: string): { agentId: AgentId; model: string | null } {
  const at = key.indexOf(SEPARATOR)
  return { agentId: key.slice(0, at) as AgentId, model: key.slice(at + 1) || null }
}

export interface MenuAgent {
  agentId: AgentId
  name: string
  /** The model option the session starts with; null when the agent's options are unknown. */
  model: ConfigOption | null
  /** Whether it can be chosen: see `canStart`. */
  choosable: boolean
}

export type MenuGroup = {
  agentId: AgentId
  /** Item keys, in the agent's order. */
  items: string[]
}

/** Whether the query starts one of the name's words, so "co" finds Codex and Claude Code. */
function namedBy(name: string, query: string): boolean {
  const q = query.toLocaleLowerCase()
  const lower = name.toLocaleLowerCase()
  return lower.startsWith(q) || lower.split(/[\s/_-]+/).some((word) => word.startsWith(q))
}

/**
 * What the agent menu lists. Without a query, the shown agent's models. With one, the matching
 * models of every agent, each agent's under its name; a query that starts a word of the agent's
 * name keeps all its models, and an agent with unknown models is kept by its name alone.
 */
export function menuGroups(
  agents: readonly MenuAgent[],
  shown: AgentId | null,
  query: string,
  contains: (text: string, query: string) => boolean,
): MenuGroup[] {
  const q = query.trim()
  const groups: MenuGroup[] = []
  for (const agent of agents) {
    if (!q && agent.agentId !== shown) continue
    if (!agent.choosable) {
      if (!q) groups.push({ agentId: agent.agentId, items: [] })
      continue
    }
    const byName = !!q && namedBy(agent.name, q)
    if (!agent.model?.choices?.length) {
      if (!q || byName)
        groups.push({ agentId: agent.agentId, items: [itemKey(agent.agentId, null)] })
      continue
    }
    const items = agent.model.choices
      .filter(
        (c) =>
          !q ||
          byName ||
          contains(`${c.name} ${c.value} ${c.description ?? ''} ${c.group ?? ''}`, q),
      )
      .map((c) => itemKey(agent.agentId, c.value))
    if (items.length > 0 || !q) groups.push({ agentId: agent.agentId, items })
  }
  return groups
}
