// A Codex session's settings as Kettu's config options. The ids, values and modes are the ones
// codex-acp offered, so sessions, their stored choices and Routines' modes carry over. Codex has
// no session settings of its own between turns: every turn sends them.

import { carriedEffort } from '@shared/effort'
import type { ConfigOption } from '@shared/thread'
import { t } from '../i18n'
import type {
  ApprovalsReviewer,
  AskForApproval,
  CollaborationModeKind,
  Model,
  ModelServiceTier,
  SandboxPolicy,
  ThreadSettings,
} from './protocol'

export const MODE_ID = 'mode'
export const COLLABORATION_ID = 'collaboration_mode'
export const MODEL_ID = 'model'
export const EFFORT_ID = 'reasoning_effort'
export const FAST_ID = 'fast-mode'
export const SERVICE_TIER_ID = 'service-tier'
export const STANDARD_SERVICE_TIER = 'default'

export type ModeId = 'read-only' | 'workspace-write' | 'agent' | 'agent-full-access'

interface Mode {
  id: ModeId
  approvalPolicy: AskForApproval
  approvalsReviewer: ApprovalsReviewer
  sandbox: SandboxPolicy
}

const WORKSPACE_WRITE: SandboxPolicy = {
  type: 'workspaceWrite',
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
}

export const MODES: readonly Mode[] = [
  {
    id: 'read-only',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
  },
  {
    id: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: WORKSPACE_WRITE,
  },
  {
    id: 'agent',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: WORKSPACE_WRITE,
  },
  {
    id: 'agent-full-access',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
  },
]

export const DEFAULT_MODE: ModeId = 'agent'

export function modeOf(id: string): Mode | null {
  return MODES.find((mode) => mode.id === id) ?? null
}

/** The mode a thread's policy matches, as codex-acp read it back on a resume; else the default. */
export function modeFromPolicy(
  settings: Pick<ThreadSettings, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'>,
): ModeId {
  const sandbox = settings.sandbox?.type
  if (settings.approvalPolicy === 'never' && sandbox === 'dangerFullAccess') {
    return 'agent-full-access'
  }
  if (settings.approvalPolicy !== 'on-request') return DEFAULT_MODE
  if (sandbox === 'readOnly') return 'read-only'
  if (sandbox === 'workspaceWrite') {
    return settings.approvalsReviewer === 'user' ? 'workspace-write' : 'agent'
  }
  return DEFAULT_MODE
}

/** What a session's turns run with. */
export interface Settings {
  mode: ModeId
  collaboration: CollaborationModeKind
  model: string
  effort: string | null
  /** Selected non-standard service tier id (e.g. `priority`, `fast`, `ultrafast`), or null for Standard. */
  serviceTier: string | null
}

const FAST_TIER_ALIASES = new Set(['fast', 'priority'])
const ULTRAFAST_TIER_ALIASES = new Set(['ultrafast', 'ultra_fast', 'ultra-fast', 'ultra fast'])
const STANDARD_TIER_ALIASES = new Set(['default', 'standard', 'off', 'normal'])

export function isStandardTier(value: string | null | undefined): boolean {
  if (!value) return true
  const normalized = value.trim().toLowerCase()
  return normalized === '' || STANDARD_TIER_ALIASES.has(normalized)
}

function isFastAlias(value: string): boolean {
  return FAST_TIER_ALIASES.has(value.trim().toLowerCase())
}

function isUltrafastAlias(value: string): boolean {
  return ULTRAFAST_TIER_ALIASES.has(value.trim().toLowerCase())
}

function isFastTier(tier: ModelServiceTier): boolean {
  return isFastAlias(tier.id) || isFastAlias(tier.name)
}

function isUltrafastTier(tier: ModelServiceTier): boolean {
  return isUltrafastAlias(tier.id) || isUltrafastAlias(tier.name)
}

function defaultTierName(id: string): string {
  if (isFastAlias(id)) return t('codex.speed.fast')
  if (isUltrafastAlias(id)) return t('codex.speed.ultrafast')
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ')
}

function displayTierName(tier: ModelServiceTier): string {
  if (isFastTier(tier) && isFastAlias(tier.name)) return t('codex.speed.fast')
  if (isUltrafastTier(tier) && isUltrafastAlias(tier.name)) return t('codex.speed.ultrafast')
  return tier.name
}

function defaultTierDescription(tier: Pick<ModelServiceTier, 'id' | 'name'>): string | undefined {
  if (isFastAlias(tier.id) || isFastAlias(tier.name)) return t('codex.option.fastDescription')
  if (isUltrafastAlias(tier.id) || isUltrafastAlias(tier.name)) {
    return t('codex.speed.ultrafastDescription')
  }
  return undefined
}

/**
 * All non-standard speed tiers advertised by `model`, preferring `serviceTiers` and falling back
 * to deprecated `additionalSpeedTiers`.
 */
export function modelSpeedTiers(model: Model | undefined): ModelServiceTier[] {
  if (!model) return []
  const seen = new Set<string>()
  const result: ModelServiceTier[] = []
  if (model.serviceTiers && model.serviceTiers.length > 0) {
    for (const item of model.serviceTiers) {
      const id = item.id.trim()
      if (!id || isStandardTier(id)) continue
      const key = id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const name = item.name.trim() || defaultTierName(id)
      const description = item.description?.trim()
      result.push({ id, name, ...(description ? { description } : {}) })
    }
    return result
  }
  for (const raw of model.additionalSpeedTiers ?? []) {
    const id = raw.trim()
    if (!id || isStandardTier(id)) continue
    const key = id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const name = defaultTierName(id)
    const description = defaultTierDescription({ id, name })
    result.push({ id, name, ...(description ? { description } : {}) })
  }
  return result
}

/** The service tier that makes a model fast, or null for one that has none. */
export function fastTier(model: Model | undefined): string | null {
  return modelSpeedTiers(model).find(isFastTier)?.id ?? null
}

/** The service tier that makes a model ultrafast, or null for one that has none. */
export function ultrafastTier(model: Model | undefined): string | null {
  return modelSpeedTiers(model).find(isUltrafastTier)?.id ?? null
}

/**
 * Resolves a requested or reported tier against the tiers advertised by `model`, normalizing
 * `fast`/`priority` and `ultrafast` aliases to the model's exact advertised tier id.
 * Returns null when the tier represents Standard or is not supported by `model`.
 */
export function resolveServiceTier(
  tier: string | null | undefined,
  model: Model | undefined,
): string | null {
  if (isStandardTier(tier)) return null
  const tiers = modelSpeedTiers(model)
  if (tiers.length === 0) return null
  const norm = tier!.trim().toLowerCase()
  const byId = tiers.find((item) => item.id.toLowerCase() === norm)
  if (byId) return byId.id
  const byName = tiers.find((item) => item.name.toLowerCase() === norm)
  if (byName) return byName.id
  if (isFastAlias(norm)) return fastTier(model)
  if (isUltrafastAlias(norm)) return ultrafastTier(model)
  return null
}

/** Reads a thread's initial/resumed `serviceTier` into `Settings.serviceTier`. */
export function initialServiceTier(
  tier: string | null | undefined,
  model: Model | undefined,
): string | null {
  if (isStandardTier(tier)) return null
  return resolveServiceTier(tier, model) ?? tier!.trim()
}

/**
 * The `serviceTier` value to send on `turn/start` or `thread/settings/update`, or undefined to omit
 * the field (when the model advertises no speed tiers or does not support the remembered tier).
 */
export function serviceTierParam(
  settings: Pick<Settings, 'serviceTier'>,
  model: Model | undefined,
): string | undefined {
  if (modelSpeedTiers(model).length === 0) return undefined
  if (settings.serviceTier === null) return STANDARD_SERVICE_TIER
  return resolveServiceTier(settings.serviceTier, model) ?? undefined
}

/**
 * Whether a thread's reported service tier means fast mode: matches the model's advertised fast
 * tier or the `fast` / `priority` aliases Codex uses across versions and config files.
 */
export function isFastServiceTier(
  tier: string | null | undefined,
  model: Model | undefined,
): boolean {
  if (isStandardTier(tier)) return false
  const advertised = fastTier(model)
  if (advertised) {
    const resolved = resolveServiceTier(tier, model)
    return resolved !== null && resolved.toLowerCase() === advertised.toLowerCase()
  }
  return isFastAlias(tier!)
}

/** A model's name as codex-acp showed it: `gpt-5.6-luna` as `5.6 Luna`. */
export function modelName(displayName: string): string {
  if (!/^gpt-/i.test(displayName)) return displayName
  return displayName.replace(/^gpt-/i, '').split(/[-/]+/).filter(Boolean).map(capitalize).join(' ')
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * The effort a model runs `wanted` at: the same when it supports it, else the nearest lower one it
 * supports, else its default.
 */
export function effortFor(model: Model | undefined, wanted: string | null): string | null {
  if (!model) return wanted
  const supported = model.supportedReasoningEfforts.map((e) => e.reasoningEffort)
  const carried = wanted ? carriedEffort(supported, wanted) : null
  return carried ?? model.defaultReasoningEffort ?? null
}

const FAMILY_ID = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/i

/** Dotted versions compared part by part, so 6.10 is newer than 6.9. */
function compareDotted(a: string, b: string): number {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The models a newer one replaces: those Codex names an upgrade for, and of the ids shaped
 * `gpt-<version>-<family>`, each but the newest of its family. Codex marks no generation, so the
 * family names are the only sign; an id of another shape is never marked.
 */
export function olderModels(models: readonly Model[]): Set<string> {
  const older = new Set(models.filter((m) => m.upgrade).map((m) => m.id))
  const parsed = models.flatMap((m) => {
    const match = FAMILY_ID.exec(m.id)
    return match ? [{ id: m.id, version: match[1]!, family: match[2]!.toLowerCase() }] : []
  })
  const newest = new Map<string, string>()
  for (const { version, family } of parsed) {
    const best = newest.get(family)
    if (best === undefined || compareDotted(version, best) > 0) newest.set(family, version)
  }
  for (const { id, version, family } of parsed) {
    if (compareDotted(version, newest.get(family)!) < 0) older.add(id)
  }
  return older
}

export function buildConfig(settings: Settings, models: readonly Model[]): ConfigOption[] {
  const listed = models.filter((model) => !model.hidden)
  const current = models.find((model) => model.id === settings.model)
  const older = olderModels(listed)
  const modelChoices: NonNullable<ConfigOption['choices']> = listed.map((model) => ({
    value: model.id,
    name: modelName(model.displayName),
    ...(model.description ? { description: model.description } : {}),
    ...(older.has(model.id) ? { older: true as const } : {}),
  }))
  if (!listed.some((model) => model.id === settings.model)) {
    modelChoices.unshift({ value: settings.model, name: modelName(settings.model) })
  }
  const options: ConfigOption[] = [
    {
      id: MODE_ID,
      name: t('codex.option.mode'),
      description: t('codex.option.modeDescription'),
      category: 'mode',
      type: 'select',
      value: settings.mode,
      choices: MODES.map((mode) => ({
        value: mode.id,
        name: t(`codex.mode.${mode.id}.name`),
        description: t(`codex.mode.${mode.id}.description`),
      })),
    },
    {
      id: COLLABORATION_ID,
      name: t('codex.option.collaboration'),
      description: t('codex.option.collaborationDescription'),
      category: 'other',
      type: 'select',
      value: settings.collaboration,
      choices: [
        { value: 'default', name: t('codex.collaboration.default') },
        {
          value: 'plan',
          name: t('codex.collaboration.plan'),
          description: t('codex.collaboration.planDescription'),
        },
      ],
    },
    {
      id: MODEL_ID,
      name: t('codex.option.model'),
      description: t('codex.option.modelDescription'),
      category: 'model',
      type: 'select',
      value: settings.model,
      choices: modelChoices,
    },
  ]
  const efforts = current?.supportedReasoningEfforts ?? []
  if (efforts.length > 0 && settings.effort) {
    options.push({
      id: EFFORT_ID,
      name: t('codex.option.effort'),
      description: t('codex.option.effortDescription'),
      category: 'thought_level',
      type: 'select',
      value: settings.effort,
      choices: efforts.map((effort) => ({
        value: effort.reasoningEffort,
        name: capitalize(effort.reasoningEffort),
        ...(effort.description ? { description: effort.description } : {}),
      })),
    })
  }
  const speedTiers = modelSpeedTiers(current)
  const activeTier = resolveServiceTier(settings.serviceTier, current)
  if (speedTiers.length === 1 && isFastTier(speedTiers[0]!)) {
    const only = speedTiers[0]!
    options.push({
      id: FAST_ID,
      name: t('codex.option.fast'),
      description: only.description || t('codex.option.fastDescription'),
      category: 'model_config',
      type: 'boolean',
      value: activeTier !== null && activeTier.toLowerCase() === only.id.toLowerCase(),
    })
  } else if (speedTiers.length > 0) {
    options.push({
      id: SERVICE_TIER_ID,
      name: t('codex.option.speed'),
      description: t('codex.option.speedDescription'),
      category: 'model_config',
      type: 'select',
      value: activeTier ?? STANDARD_SERVICE_TIER,
      choices: [
        {
          value: STANDARD_SERVICE_TIER,
          name: t('codex.speed.standard'),
          description: t('codex.speed.standardDescription'),
        },
        ...speedTiers.map((tier) => {
          const description = tier.description || defaultTierDescription(tier)
          return {
            value: tier.id,
            name: displayTierName(tier),
            ...(description ? { description } : {}),
          }
        }),
      ],
    })
  }
  return options
}

export class ConfigValueError extends Error {
  constructor(optionId: string, value: unknown) {
    super(t('codex.noValue', { value: JSON.stringify(value), option: optionId }))
    this.name = 'ConfigValueError'
  }
}

/** The settings with one option changed; throws for an option or value Codex does not have. */
export function applyOption(
  settings: Settings,
  models: readonly Model[],
  optionId: string,
  value: string | boolean,
): Settings {
  switch (optionId) {
    case MODE_ID:
      if (typeof value !== 'string' || !modeOf(value)) throw new ConfigValueError(optionId, value)
      return { ...settings, mode: value as ModeId }
    case COLLABORATION_ID:
      if (value !== 'default' && value !== 'plan') throw new ConfigValueError(optionId, value)
      return { ...settings, collaboration: value }
    case MODEL_ID: {
      if (typeof value !== 'string' || value === '') throw new ConfigValueError(optionId, value)
      const model = models.find((item) => item.id === value)
      if (models.length > 0 && !model) throw new ConfigValueError(optionId, value)
      return { ...settings, model: value, effort: effortFor(model, settings.effort) }
    }
    case EFFORT_ID: {
      const model = models.find((item) => item.id === settings.model)
      const supported =
        typeof value === 'string' &&
        (!model || model.supportedReasoningEfforts.some((e) => e.reasoningEffort === value))
      if (!supported) throw new ConfigValueError(optionId, value)
      return { ...settings, effort: value as string }
    }
    case FAST_ID: {
      const model = models.find((item) => item.id === settings.model)
      // codex-acp's select took `on` and `off`, which a stored choice may still hold.
      if (value === true || value === 'on') {
        return { ...settings, serviceTier: fastTier(model) ?? 'priority' }
      }
      if (value === false || value === 'off') return { ...settings, serviceTier: null }
      throw new ConfigValueError(optionId, value)
    }
    case SERVICE_TIER_ID: {
      if (typeof value !== 'string') throw new ConfigValueError(optionId, value)
      const trimmed = value.trim()
      if (trimmed === '') throw new ConfigValueError(optionId, value)
      if (isStandardTier(trimmed)) return { ...settings, serviceTier: null }
      const model = models.find((item) => item.id === settings.model)
      const tiers = modelSpeedTiers(model)
      if (tiers.length > 0) {
        const resolved = resolveServiceTier(trimmed, model)
        if (!resolved) throw new ConfigValueError(optionId, value)
        return { ...settings, serviceTier: resolved }
      }
      if (!model && (isFastAlias(trimmed) || isUltrafastAlias(trimmed))) {
        return { ...settings, serviceTier: trimmed }
      }
      throw new ConfigValueError(optionId, value)
    }
    default:
      throw new ConfigValueError(optionId, value)
  }
}
