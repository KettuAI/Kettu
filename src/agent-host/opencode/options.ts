// A session's options as the server's lists give them, under the ids and values `opencode acp`
// sends for the same choices, so a session keeps its stored options whichever way it runs.

import type { ConfigOption } from '@shared/thread'
import { t } from '../i18n'
import type { AgentInfo, CommandInfo, ModelInfo, ModelRef } from './protocol'

export const CONFIG = { model: 'model', effort: 'effort', mode: 'mode' } as const
/** The effort of a model run without one of its variants. */
export const DEFAULT_EFFORT = 'default'
export const DEFAULT_MODE = 'build'

/** What a folder offers: its models, the agents a session can run as, and its commands. */
export interface Offer {
  models: ModelInfo[]
  agents: AgentInfo[]
  commands: CommandInfo[]
  /** The model a session without one of its own runs on. */
  defaultModel: ModelRef | null
}

/** What a session runs on now. */
export interface Chosen {
  model: ModelRef | null
  agent: string | null
}

export function modelValue(model: { providerID: string; id: string }): string {
  return `${model.providerID}/${model.id}`
}

export function findModel(models: readonly ModelInfo[], value: string): ModelInfo | null {
  return models.find((model) => modelValue(model) === value) ?? null
}

/** The agents a session can switch to: the primary ones OpenCode shows. */
export function modes(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) => agent.mode === 'primary' && agent.hidden !== true)
}

function titled(id: string): string {
  return id === DEFAULT_EFFORT
    ? t('opencode.option.defaultEffort')
    : id.charAt(0).toUpperCase() + id.slice(1)
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function configOptions(offer: Offer, chosen: Chosen): ConfigOption[] {
  const options: ConfigOption[] = []
  const current = chosen.model ?? offer.defaultModel
  const models = [...offer.models].sort(
    (a, b) => byName(a.providerID, b.providerID) || byName(a.name, b.name),
  )
  if (models.length > 0 || current) {
    options.push({
      id: CONFIG.model,
      name: t('opencode.option.model'),
      category: 'model',
      type: 'select',
      value: current ? modelValue(current) : modelValue(models[0]!),
      choices: models.map((model) => ({
        value: modelValue(model),
        name: `${model.providerID}/${model.name}`,
      })),
    })
  }
  const variants = current
    ? (findModel(offer.models, modelValue(current))?.variants ?? []).map((variant) => variant.id)
    : []
  if (variants.length > 0) {
    const value = current?.variant && variants.includes(current.variant) ? current.variant : null
    options.push({
      id: CONFIG.effort,
      name: t('opencode.option.effort'),
      category: 'thought_level',
      type: 'select',
      value: value ?? DEFAULT_EFFORT,
      choices: [...variants, DEFAULT_EFFORT].map((id) => ({ value: id, name: titled(id) })),
    })
  }
  const agents = modes(offer.agents)
  if (agents.length > 0) {
    options.push({
      id: CONFIG.mode,
      name: t('opencode.option.mode'),
      category: 'mode',
      type: 'select',
      value: chosen.agent ?? DEFAULT_MODE,
      choices: agents.map((agent) => ({
        value: agent.id,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
      })),
    })
  }
  return options
}
