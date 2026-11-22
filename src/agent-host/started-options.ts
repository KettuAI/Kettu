// The model and effort of a session another session's agent starts: what each agent offers, read
// from the option cache, and the start values a pick becomes once checked against it.

import type { AgentOptions } from '@shared/agent-host'
import { isConfigValue, type AgentId, type ConfigOption } from '@shared/thread'
import { modelOption } from './workflow/host-agents'

/** A model an agent offers; `efforts` is null when Kettu has not yet seen the ones it offers. */
export interface OfferedModel {
  id: string
  name: string
  efforts: string[] | null
}

export interface Offered {
  /** Null when the agent offers no choice of model, or Kettu has not read its options. */
  models: OfferedModel[] | null
  /** The efforts of an agent that offers no choice of model; null for none. */
  efforts: string[] | null
}

export interface StartPick {
  model?: string
  effort?: string
}

// Past this many, an error points at list_agents instead of naming every value.
const NAMED_VALUES = 30

function choicesOf(option: ConfigOption | undefined): string[] | null {
  const values = option?.choices?.map((choice) => choice.value) ?? []
  return values.length > 0 ? values : null
}

function genericLevel(options: AgentOptions | null): ConfigOption | undefined {
  return options?.config.find((o) => o.category === 'thought_level' && o.type === 'select')
}

/**
 * The effort option of the model `value`: its own as last seen, or the cached one when the model
 * is the agent's own, whose options the cache was read at. Undefined when it is not known.
 */
function levelOf(
  options: AgentOptions | null,
  model: ConfigOption | undefined,
  value: string | null,
): ConfigOption | undefined {
  if (!model) return genericLevel(options)
  if (value === null) return undefined
  return options?.levels[value] ?? (value === model.value ? genericLevel(options) : undefined)
}

export function offered(options: AgentOptions | null): Offered {
  const model = modelOption(options)
  if (!model?.choices?.length) {
    return { models: null, efforts: choicesOf(levelOf(options, undefined, null)) }
  }
  return {
    models: model.choices.map((choice) => ({
      id: choice.value,
      name: choice.name,
      efforts: choicesOf(levelOf(options, model, choice.value)),
    })),
    efforts: null,
  }
}

function named(values: readonly string[], what: string, agentId: AgentId): string {
  return values.length <= NAMED_VALUES
    ? `Its ${what}: ${values.join(', ')}.`
    : `list_agents with agent ${agentId} lists its ${what}.`
}

/**
 * The start values of a session with `pick` over the `carried` ones, or what is wrong with it. A
 * carried effort stays on a picked model only when that model is known to offer it, so the first
 * message is never held for an effort the model lacks.
 */
export function pickedValues(
  options: AgentOptions | null,
  carried: Readonly<Record<string, string | boolean>>,
  pick: StartPick,
  agent: { id: AgentId; name: string },
): { values: Record<string, string | boolean> } | { error: string } {
  const values = { ...carried }
  const model = modelOption(options)
  if (pick.model !== undefined) {
    const choices = model?.choices?.map((choice) => choice.value) ?? []
    if (!model || choices.length === 0) {
      return { error: `${agent.name} offers no choice of model here. Leave model out.` }
    }
    if (!choices.includes(pick.model)) {
      return {
        error: `${agent.name} has no model ${pick.model}. ${named(choices, 'models', agent.id)}`,
      }
    }
    values[model.id] = pick.model
  }
  const chosen = model ? (values[model.id] ?? model.value) : null
  const modelValue = typeof chosen === 'string' ? chosen : null
  const level = levelOf(options, model, modelValue)
  const levelIds = new Set(
    [...(options?.config ?? []), ...Object.values(options?.levels ?? {})]
      .filter((o) => o.category === 'thought_level')
      .map((o) => o.id),
  )
  if (pick.effort === undefined) {
    if (pick.model === undefined) return { values }
    for (const id of levelIds) {
      const value = values[id]
      if (value === undefined) continue
      if (!level || level.id !== id || !isConfigValue(level, value)) delete values[id]
    }
    return { values }
  }
  if (level) {
    const efforts = choicesOf(level) ?? []
    if (!efforts.includes(pick.effort)) {
      const whose = modelValue === null ? agent.name : `${agent.name}'s model ${modelValue}`
      return {
        error:
          efforts.length === 0
            ? `${whose} offers no choice of effort. Leave effort out.`
            : `${whose} has no effort ${pick.effort}. ${named(efforts, 'efforts', agent.id)}`,
      }
    }
    values[level.id] = pick.effort
    return { values }
  }
  // A model's efforts are seen only once a session runs on it, so the agent checks this one.
  const id = levelIds.values().next().value
  if (id === undefined) {
    return { error: `${agent.name} offers no choice of effort here. Leave effort out.` }
  }
  values[id] = pick.effort
  return { values }
}
