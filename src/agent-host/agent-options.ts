// What New session shows for each agent before a session exists. ACP lists an agent's config
// options only in answer to `session/new` and the requests that open a session, so the host keeps
// the last list each agent gave, the reasoning levels each model offered, and the values the user
// last chose.

import path from 'node:path'
import type { AgentOptions } from '@shared/agent-host'
import { AGENT_IDS, type AgentId, type ConfigOption } from '@shared/thread'
import { JsonFile, type LogFn } from './storage'

export interface AgentOptionsFile {
  version: 1
  agents: Partial<Record<AgentId, AgentOptions>>
}

/** The categories whose values carry over to the next session; a mode never does. */
export const REMEMBERED_CATEGORIES: ReadonlySet<ConfigOption['category']> = new Set([
  'model',
  'model_config',
  'thought_level',
])

// Models whose levels are kept per agent; OpenCode lists dozens.
const MAX_LEVELS = 200

/** The order in which start values are set: a level is checked against its model's levels. */
const START_ORDER: readonly ConfigOption['category'][] = [
  'model',
  'model_config',
  'thought_level',
  'mode',
  'other',
]

/** The ids of `wanted` in the order they should be set, by their option's category. */
export function startOrder(config: readonly ConfigOption[], wanted: readonly string[]): string[] {
  const rank = (id: string) => {
    const category = config.find((o) => o.id === id)?.category
    const index = category ? START_ORDER.indexOf(category) : -1
    return index < 0 ? START_ORDER.length : index
  }
  return [...wanted].sort((a, b) => rank(a) - rank(b))
}

/** Whether `value` is one the option takes. */
export function isValueOf(option: ConfigOption, value: string | boolean): boolean {
  if (option.type === 'boolean') return typeof value === 'boolean'
  return typeof value === 'string' && !!option.choices?.some((c) => c.value === value)
}

function levelsOf(config: readonly ConfigOption[]): [string, ConfigOption] | null {
  const model = config.find((o) => o.category === 'model' && o.type === 'select')
  const level = config.find((o) => o.category === 'thought_level' && o.type === 'select')
  return model && level && typeof model.value === 'string' ? [model.value, level] : null
}

export class AgentOptionsStore {
  private readonly byAgent = new Map<AgentId, AgentOptions>()

  constructor(
    private readonly deps: {
      file: JsonFile<AgentOptionsFile>
      changed: (options: AgentOptions) => void
      now?: () => number
    },
  ) {}

  async load(): Promise<void> {
    const file = await this.deps.file.load()
    for (const [agentId, entry] of Object.entries(file.agents) as [AgentId, AgentOptions][]) {
      this.byAgent.set(agentId, entry)
    }
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }

  list(): AgentOptions[] {
    return [...this.byAgent.values()]
  }

  get(agentId: AgentId): AgentOptions | null {
    return this.byAgent.get(agentId) ?? null
  }

  /** The options of a new session, at the agent's own values, before any start value is set. */
  started(agentId: AgentId, config: readonly ConfigOption[]): void {
    if (config.length === 0) return
    const current = this.byAgent.get(agentId)
    this.put({
      agentId,
      config: [...config],
      levels: withLevels(current?.levels ?? {}, config),
      remembered: current?.remembered ?? {},
      observedAt: this.now(),
    })
  }

  /**
   * The options of a session the agent loaded or resumed, at that session's values. With none
   * known, its model, model options and level stand in, marked provisional, until a new session
   * reports the agent's defaults; a mode and the other options are left out, since they never
   * carry over. They also add the model's levels.
   */
  opened(agentId: AgentId, config: readonly ConfigOption[]): void {
    const current = this.byAgent.get(agentId)
    if (current) {
      this.put({ ...current, levels: withLevels(current.levels, config) })
      return
    }
    // Ultracode is left out too: New session sends every provisional value, and a set ultracode
    // would override the user's own Claude Code setting.
    const kept = config.filter((o) => REMEMBERED_CATEGORIES.has(o.category))
    if (kept.length === 0) return
    this.put({
      agentId,
      config: kept,
      levels: withLevels({}, config),
      remembered: {},
      observedAt: this.now(),
      provisional: true,
    })
  }

  /** Whether the agent's own defaults are known, from a new session. */
  known(agentId: AgentId): boolean {
    const entry = this.byAgent.get(agentId)
    return !!entry && !entry.provisional
  }

  /**
   * The user set an option to `value`, in a session or as a start value; `config` is the session's
   * options after it, whose levels belong to the model now chosen.
   */
  chose(
    agentId: AgentId,
    option: ConfigOption,
    value: string | boolean,
    config: readonly ConfigOption[],
  ): void {
    const current = this.byAgent.get(agentId)
    if (!current) return
    const remembered = REMEMBERED_CATEGORIES.has(option.category)
      ? { ...current.remembered, [option.id]: value }
      : current.remembered
    this.put({ ...current, remembered, levels: withLevels(current.levels, config) })
  }

  private put(next: AgentOptions): void {
    const before = this.byAgent.get(next.agentId)
    this.byAgent.set(next.agentId, next)
    if (before && contentOf(before) === contentOf(next)) return
    this.deps.file.save({ version: 1, agents: Object.fromEntries(this.byAgent) })
    this.deps.changed(next)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}

// Everything but the time it was seen, which alone is no reason to write or send.
const contentOf = (o: AgentOptions): string =>
  JSON.stringify([o.config, o.levels, o.remembered, o.provisional === true])

function withLevels(
  levels: Record<string, ConfigOption>,
  config: readonly ConfigOption[],
): Record<string, ConfigOption> {
  const entry = levelsOf(config)
  if (!entry) return levels
  const [model, level] = entry
  const next = { ...levels }
  // The model seen last goes to the end, so the oldest are dropped first.
  delete next[model]
  next[model] = level
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_LEVELS))) delete next[key]
  return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const CATEGORIES: readonly string[] = ['mode', 'model', 'model_config', 'thought_level', 'other']

function optionOf(value: unknown): ConfigOption | null {
  if (!isRecord(value)) return null
  const { id, name, description, category, type, choices, idleOnly } = value
  const v = value.value
  if (typeof id !== 'string' || typeof name !== 'string') return null
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) return null
  if (type !== 'select' && type !== 'boolean') return null
  if (type === 'select' ? typeof v !== 'string' : typeof v !== 'boolean') return null
  const option: ConfigOption = {
    id,
    name,
    category: category as ConfigOption['category'],
    type,
    value: v as string | boolean,
  }
  if (typeof description === 'string') option.description = description
  if (idleOnly === true) option.idleOnly = true
  if (Array.isArray(choices)) {
    option.choices = choices.flatMap((c) => {
      if (!isRecord(c) || typeof c.value !== 'string' || typeof c.name !== 'string') return []
      return [
        {
          value: c.value,
          name: c.name,
          ...(typeof c.description === 'string' ? { description: c.description } : {}),
          ...(typeof c.group === 'string' ? { group: c.group } : {}),
        },
      ]
    })
  }
  return option
}

// A cache of what the agents offered: an entry that does not parse is dropped, not the file.
export function parseAgentOptionsFile(data: Record<string, unknown>): AgentOptionsFile | string {
  if (!isRecord(data.agents)) return 'agents is not an object'
  const agents: AgentOptionsFile['agents'] = {}
  for (const agentId of AGENT_IDS) {
    const entry = data.agents[agentId]
    if (!isRecord(entry) || !Array.isArray(entry.config)) continue
    const config = entry.config.map(optionOf).filter((o): o is ConfigOption => o !== null)
    if (config.length === 0) continue
    const levels: Record<string, ConfigOption> = {}
    if (isRecord(entry.levels)) {
      for (const [model, option] of Object.entries(entry.levels)) {
        const level = optionOf(option)
        if (level) levels[model] = level
      }
    }
    const remembered: Record<string, string | boolean> = {}
    if (isRecord(entry.remembered)) {
      for (const [id, v] of Object.entries(entry.remembered)) {
        if (typeof v === 'string' || typeof v === 'boolean') remembered[id] = v
      }
    }
    const observedAt = typeof entry.observedAt === 'number' ? entry.observedAt : 0
    agents[agentId] = {
      agentId,
      config,
      levels,
      remembered,
      observedAt,
      ...(entry.provisional === true ? { provisional: true } : {}),
    }
  }
  return { version: 1, agents }
}

export function agentOptionsFile(userDataPath: string, log: LogFn): JsonFile<AgentOptionsFile> {
  return new JsonFile<AgentOptionsFile>({
    file: path.join(userDataPath, 'state', 'agent-options.json'),
    version: 1,
    migrations: {},
    parse: parseAgentOptionsFile,
    empty: () => ({ version: 1, agents: {} }),
    log,
  })
}
