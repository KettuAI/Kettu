// A Claude Code session's options: its permission mode, model, effort and fast mode, with the ids
// and values the ACP adapter gave them, so the values a thread stored still apply.

import type { ConfigOption } from '@shared/thread'
import type { ModelInfo, PermissionMode } from './sdk'

export const OPTION_IDS = { mode: 'mode', model: 'model', effort: 'effort', fast: 'fast' } as const

export const DEFAULT_MODEL = 'default'
export const DEFAULT_EFFORT = 'default'

const MODES: { id: PermissionMode; name: string; description: string }[] = [
  { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'Automatically accept all file edits' },
  { id: 'plan', name: 'Plan', description: 'Create a plan before making changes' },
  { id: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
  { id: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions' },
]

export function modeName(mode: string): string {
  return MODES.find((item) => item.id === mode)?.name ?? mode
}

/** The modes a session offers; bypass only where Claude Code allows it. */
export function availableModes(allowBypass: boolean): PermissionMode[] {
  return MODES.map((mode) => mode.id).filter((id) => allowBypass || id !== 'bypassPermissions')
}

export interface SessionChoices {
  mode: string
  model: string
  effort: string
  fast: boolean
}

function titleCase(level: string): string {
  return level
    .split(/[_-]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ')
}

/** The model a value names, the default model's entry for `default`. */
export function modelInfo(models: readonly ModelInfo[], value: string): ModelInfo | undefined {
  return models.find((model) => model.value === value)
}

export function buildConfig(
  models: readonly ModelInfo[],
  choices: SessionChoices,
  modes: readonly string[],
): ConfigOption[] {
  const options: ConfigOption[] = [
    {
      id: OPTION_IDS.mode,
      name: 'Mode',
      description: 'Session permission mode',
      category: 'mode',
      type: 'select',
      value: choices.mode,
      choices: MODES.filter((mode) => modes.includes(mode.id)).map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
      })),
    },
  ]
  if (models.length > 0) {
    // An alias such as `opus` follows the newest model of its family, so a row pinned to a model
    // id is an older version; Default is the alias that resolves to the same model.
    const aliases = models.filter((m) => m.resolvedModel && m.resolvedModel !== m.value)
    const listed: NonNullable<ConfigOption['choices']> = models.map((model) => {
      const same =
        model.value === DEFAULT_MODEL
          ? aliases.find((a) => a.value !== model.value && a.resolvedModel === model.resolvedModel)
          : undefined
      const older = aliases.length > 0 && model.resolvedModel === model.value
      return {
        value: model.value,
        name: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        ...(same ? { shownAs: same.value } : {}),
        ...(older ? { older: true as const } : {}),
      }
    })
    // A model the settings name that the list leaves out still shows as the one in use.
    if (!listed.some((choice) => choice.value === choices.model)) {
      listed.push({ value: choices.model, name: choices.model })
    }
    options.push({
      id: OPTION_IDS.model,
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select',
      value: choices.model,
      choices: listed,
    })
  }
  const current = modelInfo(models, choices.model)
  const levels = current?.supportsEffort ? (current.supportedEffortLevels ?? []) : []
  if (levels.length > 0) {
    options.push({
      id: OPTION_IDS.effort,
      name: 'Effort',
      description: 'Available effort levels for this model',
      category: 'thought_level',
      type: 'select',
      value: levels.includes(choices.effort) ? choices.effort : DEFAULT_EFFORT,
      choices: [
        { value: DEFAULT_EFFORT, name: 'Default' },
        ...levels.map((level) => ({ value: level, name: titleCase(level) })),
      ],
    })
  }
  if (current?.supportsFastMode) {
    options.push({
      id: OPTION_IDS.fast,
      name: 'Fast mode',
      description: 'Faster responses on supported models',
      category: 'model_config',
      type: 'boolean',
      value: choices.fast,
    })
  }
  return options
}

/** The settings' model, as the model option's value. */
export function settingsModel(models: readonly ModelInfo[], model: unknown): string {
  if (typeof model !== 'string' || model === '') return DEFAULT_MODEL
  return models.find((item) => item.value === model)?.value ?? model
}
