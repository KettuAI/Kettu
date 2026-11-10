// A Claude Code session's options: its permission mode, model, effort and fast mode, with the ids
// and values the ACP adapter gave them, so the values a thread stored still apply.

import type { ConfigOption } from '@shared/thread'
import { t } from '../i18n'
import type { ModelInfo, PermissionMode } from './sdk'

export const OPTION_IDS = {
  mode: 'mode',
  model: 'model',
  effort: 'effort',
  fast: 'fast',
  ultracode: '__ultracode',
} as const

export const DEFAULT_MODEL = 'default'
export const DEFAULT_EFFORT = 'default'

const MODES: { id: PermissionMode; name: string; description: string }[] = [
  {
    id: 'default',
    name: 'Ask before edits',
    description: 'Asks before it changes a file or runs a command',
  },
  {
    id: 'acceptEdits',
    name: 'Accept edits',
    description: 'Edits files freely; still asks before commands',
  },
  { id: 'plan', name: 'Plan only', description: 'Reads and plans. Changes nothing' },
  { id: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
  {
    id: 'bypassPermissions',
    name: 'Full access',
    description: 'Never asks. Use it in a sandbox or a worktree',
  },
]

export function modeName(mode: string): string {
  return MODES.find((item) => item.id === mode)?.name ?? mode
}

/** What a mode does, as the mode menu says it. */
export function modeDescription(mode: string): string | undefined {
  return MODES.find((item) => item.id === mode)?.description
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
  ultracode: boolean | 'default'
}

/** Kettu's ultracode switch; `default` inherits the value Claude Code resolves. */
export function ultracodeOption(
  value: boolean | 'default' = 'default',
  defaultValue: boolean | null = null,
): ConfigOption {
  return {
    id: OPTION_IDS.ultracode,
    name: 'Ultracode',
    description: t('session.ultracodeDescription'),
    category: 'other',
    type: 'boolean',
    value,
    defaultValue,
    indicator: true,
    idleOnly: true,
  }
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

/** Where a session at its default effort takes the level from, before the model's own default. */
export interface InheritedEffort {
  /** `CLAUDE_CODE_EFFORT_LEVEL`. */
  env?: string
  /** The settings' `modelSettings`, whose entries may save a level per model. */
  modelSettings?: unknown
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']

// Claude Code's documented default effort per model (code.claude.com/docs/en/model-config).
const MODEL_DEFAULT_EFFORT: [pattern: RegExp, level: string][] = [
  [/(opus|sonnet|haiku)-5-5/, 'medium'],
  [/opus-4-7/, 'xhigh'],
]
const DOCUMENTED_DEFAULT_EFFORT = 'high'

/** A model id without its context suffix or date, as `modelSettings` keys it. */
export const canonicalModel = (id: string): string =>
  id
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
    .toLowerCase()

function savedEffort(modelSettings: unknown, model: ModelInfo): string | undefined {
  if (!modelSettings || typeof modelSettings !== 'object') return undefined
  const wanted = new Set([model.value, model.resolvedModel ?? model.value].map(canonicalModel))
  for (const [key, entry] of Object.entries(modelSettings)) {
    if (!wanted.has(canonicalModel(key)) || !entry || typeof entry !== 'object') continue
    const level = (entry as { effortLevel?: unknown }).effortLevel
    if (typeof level === 'string') return level
  }
  return undefined
}

/**
 * The level a session that picked none runs at, as Claude Code resolves it: the environment, then
 * the level saved for the model, then the model's documented default, run as the highest level
 * the model offers at or below it.
 */
export function effortInEffect(
  model: ModelInfo,
  levels: readonly string[],
  inherited: InheritedEffort,
): string {
  const resolved = canonicalModel(model.resolvedModel ?? model.value)
  const wanted =
    [inherited.env, savedEffort(inherited.modelSettings, model)].find(
      (level) => level !== undefined && EFFORT_ORDER.includes(level),
    ) ??
    MODEL_DEFAULT_EFFORT.find(([pattern]) => pattern.test(resolved))?.[1] ??
    DOCUMENTED_DEFAULT_EFFORT
  if (levels.includes(wanted)) return wanted
  const rank = EFFORT_ORDER.indexOf(wanted)
  const below = levels.filter((level) => {
    const at = EFFORT_ORDER.indexOf(level)
    return at >= 0 && at <= rank
  })
  return below.at(-1) ?? levels[0]!
}

export function buildConfig(
  models: readonly ModelInfo[],
  choices: SessionChoices,
  modes: readonly string[],
  ultracodeDefault: boolean | null = null,
  inherited: InheritedEffort = {},
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
      const modelId =
        model.resolvedModel ?? (model.value === DEFAULT_MODEL ? undefined : model.value)
      return {
        value: model.value,
        name: model.displayName,
        ...(modelId ? { modelId } : {}),
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
  if (current && levels.length > 0) {
    // A session at its default shows the level that default runs at; there is no Default level.
    options.push({
      id: OPTION_IDS.effort,
      name: 'Effort',
      description: 'Available effort levels for this model',
      category: 'thought_level',
      type: 'select',
      value: levels.includes(choices.effort)
        ? choices.effort
        : effortInEffect(current, levels, inherited),
      choices: levels.map((level) => ({ value: level, name: titleCase(level) })),
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
  options.push(ultracodeOption(choices.ultracode, ultracodeDefault))
  return options
}

/** The settings' model, as the model option's value. */
export function settingsModel(models: readonly ModelInfo[], model: unknown): string {
  if (typeof model !== 'string' || model === '') return DEFAULT_MODEL
  return models.find((item) => item.value === model)?.value ?? model
}
