import type { AgentOptions, AgentStatus, HarnessReason } from '@shared/agent-host'
import { isStartMode } from '@shared/agents'
import { isConfigValue, type AgentId, type ConfigOption, type HarnessId } from '@shared/thread'
import { harnessReason, programHere, sharedReason } from '@renderer/features/agents/harness-problem'
import { cliOutdated, listedInstalled, readiness } from '@renderer/features/agents/readiness'
import {
  modelLists,
  moreInOrder,
  type KeptModels,
  type ModelLists,
  type ModelRead,
} from '@renderer/features/session/composer/model-list'
import type { OptionValues } from '@renderer/stores/agent-options'

/**
 * What an agent needs before New session can start it, by the checks Settings > Harnesses lists
 * it with. `adapter` is a package agent whose adapter is not installed yet, and `install` one
 * missing from the machine: neither can be chosen until Settings > Harnesses installs it. `update`
 * is the user's own program, found but older than Kettu needs: it cannot start until it is
 * updated. `blocked` is a harness on the machine that cannot run for something else, such as
 * Node.js or a program that does not answer: it cannot start until that is fixed. `setup` is an
 * agent with the user's own program but not yet its adapter: the user installed the agent, so it
 * can be chosen, and its first start installs the adapter.
 */
export type AgentNeed =
  | 'install'
  | 'update'
  | 'blocked'
  | 'installing'
  | 'failed'
  | 'adapter'
  | 'setup'
  | 'sign-in'
  | null

export function agentNeed(status: AgentStatus): AgentNeed {
  if (cliOutdated(status) !== null) return 'update'
  const r = readiness(status)
  if (r.kind === 'missing') return programHere(status) ? 'blocked' : 'install'
  if (r.kind === 'installing') return 'installing'
  if (r.kind === 'failed') return 'failed'
  if (!listedInstalled(status)) {
    return status.cli ? 'setup' : 'adapter'
  }
  return r.kind === 'sign-in' ? 'sign-in' : null
}

/** Whether New session lists the agent in its menu, even when it cannot start yet. */
function listable(status: AgentStatus): boolean {
  if (status.registered === false || status.disabled) return false
  const need = agentNeed(status)
  return need !== 'install' && need !== 'adapter'
}

/** Whether New session can start the agent. */
export function canStart(status: AgentStatus): boolean {
  const need = agentNeed(status)
  return listable(status) && need !== 'update' && need !== 'blocked'
}

/** What stops every agent New session could start: the reason, and the agents and harnesses. */
export interface NoAgentReason {
  /** Null when none has a reason of its harness, as when none is on. */
  reason: HarnessReason | null
  agents: string[]
  harnesses: HarnessId[]
}

// Which reason the line names first: installing Node.js serves every agent waiting for it.
const REASON_ORDER: HarnessReason['kind'][] = [
  'needs-node',
  'too-old',
  'needs-npm',
  'needs-uv',
  'cannot-run',
  'not-installed',
  'no-version',
]

/** While no agent can start, what stops them; null once one can start, or while none is known. */
export function noAgentCanStart(statuses: AgentStatus[]): NoAgentReason | null {
  if (statuses.some(canStart)) return null
  const stopped = statuses.flatMap((status) => {
    const reason = harnessReason(status)
    return reason ? [{ status, reason }] : []
  })
  for (const kind of REASON_ORDER) {
    const group = stopped.filter((entry) => entry.reason.kind === kind)
    if (group.length === 0) continue
    return {
      reason: sharedReason(group.map((entry) => entry.reason)),
      agents: group.map((entry) => entry.status.name),
      harnesses: [...new Set(group.map((entry) => entry.status.harnessId))],
    }
  }
  return { reason: null, agents: [], harnesses: [] }
}

// The categories whose last chosen values carry over to the next session, as the host keeps them.
const REMEMBERED: ReadonlySet<ConfigOption['category']> = new Set([
  'model',
  'model_config',
  'thought_level',
])

function takes(option: ConfigOption, value: string | boolean): boolean {
  return isConfigValue(option, value)
}

/** How a new session's options are worked out: with `startMode`, the agent's start mode is applied. */
export interface StartFlags {
  startMode?: boolean
}

/** The mode option the agent's start mode is set on, and that mode, when it offers it. */
function startModeOf(entry: AgentOptions): { optionId: string; value: string } | null {
  if (!isStartMode(entry.agentId, entry.startMode)) return null
  const option = entry.config.find((o) => o.category === 'mode' && o.type === 'select')
  return option && takes(option, entry.startMode)
    ? { optionId: option.id, value: entry.startMode }
    : null
}

/**
 * The options a new session with the agent starts with: the agent's own defaults, then the values
 * remembered from earlier sessions, then what New session set. With `startMode`, the mode is the
 * start mode the user chose for the agent, which only a pick of the mode overrides. A value the
 * option no longer takes is passed over. The level is the one the chosen model offered when last
 * seen, since an agent's levels can differ by model.
 */
export function startConfig(
  entry: AgentOptions,
  picks: OptionValues = {},
  { startMode = false }: StartFlags = {},
): ConfigOption[] {
  const start = startMode ? startModeOf(entry) : null
  const valueOf = (option: ConfigOption): string | boolean => {
    const pick = picks[option.id]
    if (pick !== undefined && takes(option, pick)) return pick
    if (start?.optionId === option.id) return start.value
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
 * every value for a provisional entry, whose values need not be the agent's defaults. With
 * `startMode`, a pick of the mode is sent even when it is the agent's own, since it overrides the
 * start mode the session would otherwise start in.
 */
export function startValues(
  entry: AgentOptions,
  picks: OptionValues = {},
  flags: StartFlags = {},
): OptionValues {
  const defaults = new Map(entry.provisional ? [] : entry.config.map((o) => [o.id, o.value]))
  const start = flags.startMode ? startModeOf(entry) : null
  const values: OptionValues = {}
  for (const option of startConfig(entry, picks, flags)) {
    const picked = start?.optionId === option.id && picks[option.id] === option.value
    if (picked || defaults.get(option.id) !== option.value) values[option.id] = option.value
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

/** The key of the row that shows or hides an agent's older models. */
export function moreKey(agentId: AgentId): string {
  return `${agentId}${SEPARATOR}${SEPARATOR}`
}

export function isMoreKey(key: string): boolean {
  return key.endsWith(SEPARATOR + SEPARATOR)
}

/** An agent's model lists by the menus' rule, or null while its models are unknown. */
export function agentLists(agent: MenuAgent): ModelLists | null {
  const option = agent.model
  if (!option?.choices?.length) return null
  return modelLists(option.choices, String(option.value), agent.kept)
}

export interface MenuAgent {
  agentId: AgentId
  name: string
  /** The model option the session starts with; null when the agent's options are unknown. */
  model: ConfigOption | null
  /** The models the user pinned for it and used last. */
  kept?: KeptModels
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
 * What the agent menu lists. Without a query, the shown agent's main models, then the More models
 * row, then the rest while `expanded` names it, by provider and family. With one, the matching
 * models of every agent, each agent's under its name; a query that starts a word of the agent's
 * name keeps all its models, and an agent with unknown models is kept by its name alone.
 */
export function menuGroups(
  agents: readonly MenuAgent[],
  shown: AgentId | null,
  query: string,
  contains: (text: string, query: string) => boolean,
  expanded: AgentId | null = null,
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
    const lists = agentLists(agent)!
    if (!q) {
      const keys = (list: readonly ModelRead[]) => list.map((r) => itemKey(agent.agentId, r.value))
      const items = keys(lists.main)
      if (lists.more.length > 0) items.push(moreKey(agent.agentId))
      if (expanded === agent.agentId) items.push(...keys(moreInOrder(lists.more)))
      groups.push({ agentId: agent.agentId, items })
      continue
    }
    const items = lists.all
      .filter(
        ({ choice: c }) =>
          byName || contains(`${c.name} ${c.value} ${c.description ?? ''} ${c.group ?? ''}`, q),
      )
      .map((r) => itemKey(agent.agentId, r.value))
    if (items.length > 0) groups.push({ agentId: agent.agentId, items })
  }
  return groups
}

/**
 * The agents New session can start, the installed first, each group in catalog order with each
 * harness's default agent first. Hidden default agents stay out, and the harnesses still to
 * install are installed in Settings > Harnesses, so the menu leaves them out too. With
 * `updates`, an agent whose own program needs updating is listed as well, to offer the update.
 */
export function menuAgents(statuses: AgentStatus[], updates = false): AgentStatus[] {
  const listed = statuses.filter((s) => (updates ? listable(s) : canStart(s)) && !s.hidden)
  return [...listed.filter(listedInstalled), ...listed.filter((s) => !listedInstalled(s))]
}
