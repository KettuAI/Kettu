// The settings a Claude Code agent's page edits in its user settings file: the auto-compact window
// for all models and for each model, and the prompt cache duration. Nothing else in the file is
// read, and every other key stays as the user left it.

import type { ClaudeCompactRow, ClaudeSettingChange, ClaudeSettings } from '@shared/agent-host'
import {
  AUTO_COMPACT_MAX,
  AUTO_COMPACT_MIN,
  canonicalClaudeModel as canonicalModel,
  PROMPT_CACHE_TTLS,
  type PromptCacheTtl,
} from '@shared/agents'
import type { ConfigOption } from '@shared/thread'
import { isObject, readSettings, writeSettings } from '../settings-file'

/** A model the agent lists: its id as the settings key it, and the name it shows. */
export interface ListedModel {
  id: string
  name: string
}

const MAX_MODEL_CHARS = 256

/** The models in an agent's cached options, once each, aliases resolved to the model they follow. */
export function listedModels(config: readonly ConfigOption[] | undefined): ListedModel[] {
  const option = config?.find((o) => o.category === 'model' && o.type === 'select')
  const seen = new Set<string>()
  const models: ListedModel[] = []
  for (const choice of option?.choices ?? []) {
    // A row shown as another one is the same model under its alias.
    if (choice.shownAs || !choice.modelId) continue
    const id = canonicalModel(choice.modelId)
    if (seen.has(id)) continue
    seen.add(id)
    models.push({ id, name: choice.name })
  }
  return models
}

/** The window in a settings object or a model's entry; null when it has none. */
function windowOf(entry: unknown): number | null {
  if (!isObject(entry)) return null
  const value = entry.autoCompactWindow
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Reads the two settings from the file, with a row for every listed model and every saved one. */
export async function readClaudeSettings(
  file: string,
  listed: readonly ListedModel[],
): Promise<ClaudeSettings> {
  const settings = await readSettings(file)
  const saved = new Map<string, number>()
  if (isObject(settings.modelSettings)) {
    for (const [key, entry] of Object.entries(settings.modelSettings)) {
      const window = windowOf(entry)
      const id = canonicalModel(key)
      if (window !== null && !saved.has(id)) saved.set(id, window)
    }
  }
  const compact: ClaudeCompactRow[] = listed.map((model) => ({
    model: model.id,
    name: model.name,
    window: saved.get(model.id) ?? null,
  }))
  for (const [model, window] of saved) {
    if (!listed.some((item) => item.id === model)) compact.push({ model, name: null, window })
  }
  const ttl = settings.promptCacheTtl
  return {
    defaultWindow: windowOf(settings),
    compact,
    promptCacheTtl: (PROMPT_CACHE_TTLS as readonly unknown[]).includes(ttl)
      ? (ttl as PromptCacheTtl)
      : null,
  }
}

/** Checks a change before anything is written, so only a model name, a window or a duration is. */
export function checkClaudeSetting(change: ClaudeSettingChange): ClaudeSettingChange {
  if (change.setting === 'promptCacheTtl') {
    if (change.value !== null && !PROMPT_CACHE_TTLS.includes(change.value)) {
      throw new Error('The prompt cache duration must be 5m or 1h')
    }
    return change
  }
  const model = change.model === null ? null : change.model.trim()
  if (
    model !== null &&
    (model.length === 0 || model.length > MAX_MODEL_CHARS || /\s/.test(model))
  ) {
    throw new Error('The model must be one word without spaces')
  }
  const { value } = change
  if (
    value !== null &&
    !(Number.isInteger(value) && value >= AUTO_COMPACT_MIN && value <= AUTO_COMPACT_MAX)
  ) {
    throw new Error(`The window must be from ${AUTO_COMPACT_MIN} to ${AUTO_COMPACT_MAX} tokens`)
  }
  return { setting: 'autoCompactWindow', model, value }
}

/** The settings with the model's window set, or removed for null; null when nothing changes. */
function withWindow(
  file: string,
  settings: Record<string, unknown>,
  model: string,
  value: number | null,
): Record<string, unknown> | null {
  if (settings.modelSettings !== undefined && !isObject(settings.modelSettings)) {
    throw new Error(
      `modelSettings in ${file} is not an object; fix it or set the window there yourself`,
    )
  }
  const models: Record<string, unknown> = isObject(settings.modelSettings)
    ? { ...settings.modelSettings }
    : {}
  const id = canonicalModel(model)
  // Every spelling of the model in the file takes the value, so none disagrees with another.
  const keys = Object.keys(models).filter((key) => canonicalModel(key) === id)
  let changed = false
  if (value === null) {
    for (const key of keys) {
      const entry = models[key]
      if (!isObject(entry) || !('autoCompactWindow' in entry)) continue
      const rest = { ...entry }
      delete rest.autoCompactWindow
      if (Object.keys(rest).length > 0) models[key] = rest
      else delete models[key]
      changed = true
    }
  } else {
    for (const key of keys.length > 0 ? keys : [id]) {
      const entry = isObject(models[key]) ? models[key] : {}
      if (entry.autoCompactWindow === value) continue
      models[key] = { ...entry, autoCompactWindow: value }
      changed = true
    }
  }
  if (!changed) return null
  const next: Record<string, unknown> = { ...settings, modelSettings: models }
  if (Object.keys(models).length === 0) delete next.modelSettings
  return next
}

/** The settings with the window for all models set, or removed for null; null when nothing changes. */
function withDefaultWindow(
  settings: Record<string, unknown>,
  value: number | null,
): Record<string, unknown> | null {
  if (settings.autoCompactWindow === (value ?? undefined)) return null
  const next = { ...settings }
  if (value === null) delete next.autoCompactWindow
  else next.autoCompactWindow = value
  return next
}

function withTtl(
  settings: Record<string, unknown>,
  value: PromptCacheTtl | null,
): Record<string, unknown> | null {
  if (settings.promptCacheTtl === (value ?? undefined)) return null
  const next = { ...settings }
  if (value === null) delete next.promptCacheTtl
  else next.promptCacheTtl = value
  return next
}

/** Writes one change into the settings file, keeping everything else in it. */
export async function writeClaudeSetting(file: string, input: ClaudeSettingChange): Promise<void> {
  const change = checkClaudeSetting(input)
  const settings = await readSettings(file)
  const next =
    change.setting === 'promptCacheTtl'
      ? withTtl(settings, change.value)
      : change.model === null
        ? withDefaultWindow(settings, change.value)
        : withWindow(file, settings, change.model, change.value)
  if (next) await writeSettings(file, next)
}
