// What New session shows for each agent until its prepared session answers. ACP lists an agent's
// config options only in answer to `session/new` and the requests that open a session, so the host
// keeps the last list each agent gave, its own values in each folder, the reasoning levels each
// model offered, the values the user last chose, and the models the user pinned or last used.

import path from 'node:path'
import { MAX_PINNED_MODELS, MAX_RECENT_MODELS, type AgentOptions } from '@shared/agent-host'
import { isStartMode } from '@shared/agents'
import type { HostSettings } from '@shared/settings'
import { isAgentId, isConfigValue, type AgentId, type ConfigOption } from '@shared/thread'
import { HostError, notFound } from './errors'
import { t } from './i18n'
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
// Folders whose own values are kept per agent, the latest first to stay.
const MAX_FOLDERS = 50

/** The start mode the settings name for the agent, when it takes one. */
export function startModeIn(
  settings: Pick<HostSettings, 'startModes'>,
  agentId: AgentId,
): string | undefined {
  const mode = settings.startModes[agentId]
  return isStartMode(agentId, mode) ? mode : undefined
}

/** A remembered value dropped because the agent's own value changed outside Kettu since. */
export interface ReplacedValue {
  option: ConfigOption // as the session lists it, at the agent's own value
  wanted: string | boolean
}

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
export const isValueOf = isConfigValue

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

  /**
   * The options of a new session in the folder `folderKey`, at the agent's own values, before any
   * start value is set. A remembered value whose option's own value in that folder changed since
   * it was last seen there is dropped and returned: the change outside Kettu came after the
   * user's choice, so it wins.
   */
  started(agentId: AgentId, config: readonly ConfigOption[], folderKey?: string): ReplacedValue[] {
    if (config.length === 0) return []
    const current = this.byAgent.get(agentId)
    const remembered = { ...current?.remembered }
    const replaced: ReplacedValue[] = []
    const before = folderKey === undefined ? undefined : current?.defaults?.[folderKey]
    if (before) {
      for (const [id, wanted] of Object.entries(remembered)) {
        const option = config.find((o) => o.id === id)
        if (!option || !(id in before) || before[id] === option.value) continue
        delete remembered[id]
        if (wanted !== option.value) replaced.push({ option, wanted })
      }
    }
    const defaults =
      folderKey === undefined
        ? current?.defaults
        : withDefaults(current?.defaults ?? {}, folderKey, config)
    this.put({
      agentId,
      config: [...config],
      levels: withLevels(current?.levels ?? {}, config),
      remembered,
      ...(defaults ? { defaults } : {}),
      ...(current?.pinned ? { pinned: current.pinned } : {}),
      ...(current?.recent ? { recent: current.recent } : {}),
      observedAt: this.now(),
    })
    return replaced
  }

  /** The values last chosen for the agent, by option id. */
  rememberedOf(agentId: AgentId): Record<string, string | boolean> {
    return { ...this.byAgent.get(agentId)?.remembered }
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
      // The models it lists are what the agent offers now; the values stay its own.
      this.put({
        ...current,
        config: withModels(current.config, config),
        levels: withLevels(current.levels, config),
        observedAt: this.now(),
      })
      return
    }
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
    const next = { ...current, remembered, levels: withLevels(current.levels, config) }
    const model = option.category === 'model' ? modelInUse(config) : null
    this.put(model ? withRecent(next, model) : next)
  }

  /**
   * A value was set that is not the user's choice, as one an agent picked for a session it
   * started: only the levels `config` shows for its model are kept.
   */
  seen(agentId: AgentId, config: readonly ConfigOption[]): void {
    const current = this.byAgent.get(agentId)
    if (current) this.put({ ...current, levels: withLevels(current.levels, config) })
  }

  /**
   * Pins `model` to the top of the agent's model menu, after the ones pinned before, or unpins it.
   * Throws when the agent has no options kept, or when it already has `MAX_PINNED_MODELS` pins.
   */
  pin(agentId: AgentId, model: string, pinned: boolean): void {
    const current = this.byAgent.get(agentId)
    if (!current) throw notFound(t('agent.noModelsKept', { agent: agentId }))
    const before = current.pinned ?? []
    const has = before.includes(model)
    if (pinned && !has && before.length >= MAX_PINNED_MODELS) {
      throw new HostError('conflict', t('agent.pinsFull', { count: MAX_PINNED_MODELS }))
    }
    const next = pinned ? (has ? before : [...before, model]) : before.filter((v) => v !== model)
    this.put(withList(current, 'pinned', next))
  }

  /** A session of the agent with these options is used, so its model leads the recent ones. */
  used(agentId: AgentId, config: readonly ConfigOption[]): void {
    const current = this.byAgent.get(agentId)
    const model = modelInUse(config)
    if (current && model) this.put(withRecent(current, model))
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
  JSON.stringify([
    o.config,
    o.levels,
    o.remembered,
    o.defaults ?? {},
    o.provisional === true,
    o.pinned ?? [],
    o.recent ?? [],
  ])

/**
 * The model a session's options are on, as its model menu lists it: a choice shown as another
 * counts as that one, as Claude Code's Default does as the model it stands for.
 */
export function modelInUse(config: readonly ConfigOption[]): string | null {
  const option = config.find((o) => o.category === 'model' && o.type === 'select')
  if (!option || typeof option.value !== 'string') return null
  return option.choices?.find((c) => c.value === option.value)?.shownAs ?? option.value
}

/** The entry with `model` first among its recent models. */
function withRecent(entry: AgentOptions, model: string): AgentOptions {
  if (entry.recent?.[0] === model) return entry
  const recent = [model, ...(entry.recent ?? []).filter((value) => value !== model)]
  return withList(entry, 'recent', recent.slice(0, MAX_RECENT_MODELS))
}

/** The entry with `list` set to `values`, or without it when they are none. */
function withList(entry: AgentOptions, list: 'pinned' | 'recent', values: string[]): AgentOptions {
  const next = { ...entry }
  if (values.length > 0) next[list] = values
  else delete next[list]
  return next
}

function withDefaults(
  defaults: Record<string, Record<string, string | boolean>>,
  folderKey: string,
  config: readonly ConfigOption[],
): Record<string, Record<string, string | boolean>> {
  const next = { ...defaults }
  // The folder seen last goes to the end, so the oldest are dropped first.
  delete next[folderKey]
  next[folderKey] = Object.fromEntries(
    config.filter((o) => REMEMBERED_CATEGORIES.has(o.category)).map((o) => [o.id, o.value]),
  )
  const keys = Object.keys(next)
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_FOLDERS))) delete next[key]
  return next
}

/** The cached options with the model lists of `seen`, keeping each cached value it still offers. */
function withModels(
  cached: readonly ConfigOption[],
  seen: readonly ConfigOption[],
): ConfigOption[] {
  return cached.map((option) => {
    if (option.category !== 'model') return option
    const fresh = seen.find((o) => o.id === option.id && o.type === option.type)
    if (!fresh) return option
    return { ...fresh, value: isValueOf(fresh, option.value) ? option.value : fresh.value }
  })
}

/**
 * `own` with the model lists `fresh` gives, each option keeping its value even when the agent no
 * longer lists it, and the models it newly lists. Null when no list changed.
 */
export function withFreshModels(
  own: readonly ConfigOption[],
  fresh: readonly ConfigOption[],
): { config: ConfigOption[]; added: string[] } | null {
  const added: string[] = []
  let changed = false
  const config = own.map((option) => {
    if (option.category !== 'model' || option.type !== 'select' || !option.choices) return option
    const seen = fresh.find((o) => o.id === option.id && o.type === 'select')
    if (!seen?.choices || seen.choices.length === 0) return option
    const kept = seen.choices.some((c) => c.value === option.value)
      ? []
      : option.choices.filter((c) => c.value === option.value)
    const choices = [...seen.choices, ...kept]
    if (JSON.stringify(choices) === JSON.stringify(option.choices)) return option
    const before = new Set(option.choices.map((c) => c.value))
    added.push(...choices.filter((c) => !before.has(c.value)).map((c) => c.value))
    changed = true
    return { ...option, choices }
  })
  return changed ? { config, added } : null
}

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
  const { id, name, description, category, type, choices, idleOnly, defaultValue, indicator } =
    value
  const v = value.value
  if (typeof id !== 'string' || typeof name !== 'string') return null
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) return null
  if (type !== 'select' && type !== 'boolean') return null
  const inherits = typeof defaultValue === 'boolean' || defaultValue === null
  if (
    type === 'select'
      ? typeof v !== 'string'
      : typeof v !== 'boolean' && !(v === 'default' && inherits)
  )
    return null
  const option: ConfigOption = {
    id,
    name,
    category: category as ConfigOption['category'],
    type,
    value: v as string | boolean,
  }
  if (typeof description === 'string') option.description = description
  if (idleOnly === true) option.idleOnly = true
  if (type === 'boolean' && inherits) option.defaultValue = defaultValue
  if (indicator === true) option.indicator = true
  if (Array.isArray(choices)) {
    option.choices = choices.flatMap((c) => {
      if (!isRecord(c) || typeof c.value !== 'string' || typeof c.name !== 'string') return []
      return [
        {
          value: c.value,
          name: c.name,
          ...(typeof c.description === 'string' ? { description: c.description } : {}),
          ...(typeof c.group === 'string' ? { group: c.group } : {}),
          ...(c.older === true ? { older: true as const } : {}),
          ...(typeof c.shownAs === 'string' ? { shownAs: c.shownAs } : {}),
          ...(typeof c.modelId === 'string' ? { modelId: c.modelId } : {}),
        },
      ]
    })
  }
  return option
}

/** A kept list of model values: strings only, each once, at most `max` of them. */
function modelList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  const values = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return [...new Set(values)].slice(0, max)
}

// A cache of what the agents offered: an entry that does not parse is dropped, not the file.
export function parseAgentOptionsFile(data: Record<string, unknown>): AgentOptionsFile | string {
  if (!isRecord(data.agents)) return 'agents is not an object'
  const agents: AgentOptionsFile['agents'] = {}
  for (const agentId of Object.keys(data.agents).filter(isAgentId)) {
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
    const defaults: Record<string, Record<string, string | boolean>> = {}
    if (isRecord(entry.defaults)) {
      for (const [folder, values] of Object.entries(entry.defaults)) {
        if (!isRecord(values)) continue
        const kept: Record<string, string | boolean> = {}
        for (const [id, v] of Object.entries(values)) {
          if (typeof v === 'string' || typeof v === 'boolean') kept[id] = v
        }
        defaults[folder] = kept
      }
    }
    const pinned = modelList(entry.pinned, MAX_PINNED_MODELS)
    const recent = modelList(entry.recent, MAX_RECENT_MODELS)
    agents[agentId] = {
      agentId,
      config,
      levels,
      remembered,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
      observedAt,
      ...(entry.provisional === true ? { provisional: true } : {}),
      ...(pinned.length > 0 ? { pinned } : {}),
      ...(recent.length > 0 ? { recent } : {}),
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
