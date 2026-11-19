// A Pi session's options: its model, among the models of every provider pi is signed in to, and
// its thinking level, among the levels its model takes. The ids and names are the ones Kettu's
// stored sessions and remembered choices already hold.

import type { ConfigOption } from '@shared/thread'
import type { PiModel } from './protocol'

export const CONFIG = { model: 'model', level: 'thought_level' } as const

// The models an extension reports are bounded, since the extension runs in the agent.
const MAX_SCOPE = 10_000

/** A model as the model option names it: its provider, then its id, which may hold slashes. */
export function modelValue(model: Pick<PiModel, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

/** The provider and id a model option's value names, or null when it names none. */
export function parseModelValue(value: string): { provider: string; modelId: string } | null {
  const at = value.indexOf('/')
  if (at <= 0 || at === value.length - 1) return null
  return { provider: value.slice(0, at), modelId: value.slice(at + 1) }
}

/** Whether pi has a model to run: with no provider signed in it names `unknown/unknown`. */
export function hasModel(model: PiModel | undefined | null): model is PiModel {
  return (
    !!model &&
    !!model.provider &&
    !!model.id &&
    !(model.provider === 'unknown' && model.id === 'unknown')
  )
}

/**
 * The models Kettu's extension reports pi scoped the session to, from the JSON it sends; null
 * when it reports none, as when pi has no scope.
 */
export function parseScope(text: string | undefined): ReadonlySet<string> | null {
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const models =
    typeof parsed === 'object' && parsed !== null ? (parsed as { models?: unknown }).models : null
  if (!Array.isArray(models)) return null
  const scope = new Set(
    models.filter((model): model is string => typeof model === 'string').slice(0, MAX_SCOPE),
  )
  return scope.size > 0 ? scope : null
}

export interface Choices {
  model: PiModel | null
  level: string
  models: readonly PiModel[]
  levels: readonly string[]
  /** The models pi scoped the session to; null for every model. */
  scope: ReadonlySet<string> | null
}

export function configOptions(choices: Choices): ConfigOption[] {
  const options: ConfigOption[] = []
  const current = choices.model ? modelValue(choices.model) : null
  const listed = choices.models.filter((model) => model.provider && model.id)
  if (listed.length > 0 || current) {
    const shown = listed.filter((model) => {
      const value = modelValue(model)
      return !choices.scope || choices.scope.has(value) || value === current
    })
    // A model pi runs but no longer lists stays the session's, so the menu still names it.
    const known = current === null || shown.some((model) => modelValue(model) === current)
    const models = known || !choices.model ? shown : [choices.model, ...shown]
    options.push({
      id: CONFIG.model,
      name: 'Model',
      description: 'Select the model for this session',
      category: 'model',
      type: 'select',
      value: current ?? modelValue(models[0]!),
      choices: models.map((model) => ({
        value: modelValue(model),
        name: `${model.provider}/${model.name ?? model.id}`,
      })),
    })
  }
  const levels = choices.levels.includes(choices.level)
    ? choices.levels
    : [...choices.levels, choices.level]
  options.push({
    id: CONFIG.level,
    name: 'Thinking',
    description: 'Set the reasoning effort for this session',
    category: 'thought_level',
    type: 'select',
    value: choices.level,
    choices: levels.map((level) => ({ value: level, name: `Thinking: ${level}` })),
  })
  return options
}
