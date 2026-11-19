// A DeepSeek Harness session's options: its model, which is one of the models its home configures,
// that model's reasoning level, and its mode, which is dsh's permission preset or its plan mode.
// Its process starts with the model and the level.

import type { ConfigOption } from '@shared/thread'
import { t } from '../i18n'
import type { Provider } from './credentials'
import type { ListedModel } from './listing'
import type { Routes } from './routes'

export const CONFIG = { mode: 'mode', model: 'model', effort: 'effort' } as const

/** The models dsh 0.2.2 ships for DeepSeek's own routes, which it lists until a file replaces them. */
const BUILT_IN = [
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', efforts: null },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', efforts: null },
] as const

/** The reasoning levels of DeepSeek's own models. */
const DEEPSEEK_EFFORTS = ['off', 'low', 'high', 'max'] as const
const DEEPSEEK_EFFORT = 'high'
const DEEPSEEK_PROVIDERS: readonly string[] = ['deepseek-official', 'deepseek-account']
const DEEPSEEK_GROUP = 'DeepSeek'

/** The level that sends none, so another route's model runs at its endpoint's own. */
export const DEFAULT_LEVEL = 'default'

/** The levels Kettu has a name for; a route may declare others, shown as written. */
const NAMED_LEVELS = [
  DEFAULT_LEVEL,
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/** The modes, in the menu's order: plan mode, then the permission presets from narrow to broad. */
export const MODES = ['plan', 'read-only', 'workspace-write', 'danger-full-access'] as const

export type Mode = (typeof MODES)[number]

export const DEFAULT_PRESET = 'workspace-write'

export function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value)
}

/** A model the session can run on, as the model menu offers it. */
export interface ModelChoice {
  /** The menu's value: the bare id on DeepSeek's own route, else the route and the id. */
  value: string
  /** The route's name in dsh; null for DeepSeek's own, which the sign-in picks. */
  provider: string | null
  model: string
  name: string
  group: string
  /** The levels its menu offers; empty when the model declares none. */
  efforts: readonly string[]
  /** The level a session starts it on; null when it has none. */
  effort: string | null
  /** dsh's own names for its levels, shown for a level Kettu has no name for. */
  effortNames?: Readonly<Record<string, string>>
}

/**
 * The models the home's files name, which stand in until dsh's own list is read. DeepSeek's own
 * need its sign-in, so a home that is not signed in to DeepSeek lists them only when it has no
 * other route, where they lead to the sign-in.
 */
export function modelChoices(routes: Routes, signedIn: Provider | null): ModelChoice[] {
  const choices: ModelChoice[] = []
  const add = (choice: ModelChoice): void => {
    if (!choices.some((listed) => listed.value === choice.value)) choices.push(choice)
  }
  // dsh saves the level chosen in its own pages with the model new sessions start on.
  const chosen = (provider: string | null, model: string, efforts: readonly string[]) => {
    const { selection } = routes
    if (!selection?.effort || selection.model !== model || !efforts.includes(selection.effort))
      return null
    const own = DEEPSEEK_PROVIDERS.includes(selection.provider)
    return (provider === null ? own : selection.provider === provider) ? selection.effort : null
  }
  if (signedIn !== null || routes.groups.length === 0) {
    // The account route takes its catalog from the account service, not from the key route's.
    const own = signedIn === 'deepseek-account' ? null : routes.deepseek
    const wanted = routes.deepseek?.effort ?? DEEPSEEK_EFFORT
    for (const model of own?.models ?? BUILT_IN) {
      const efforts: readonly string[] = model.efforts ?? DEEPSEEK_EFFORTS
      add({
        value: model.id,
        provider: null,
        model: model.id,
        name: model.name,
        group: DEEPSEEK_GROUP,
        efforts,
        effort:
          chosen(null, model.id, efforts) ??
          (efforts.includes(wanted) ? wanted : (efforts[0] ?? null)),
      })
    }
  }
  for (const group of routes.groups) {
    for (const model of group.models) {
      const declared = model.efforts ?? []
      const efforts = declared.length > 0 ? [DEFAULT_LEVEL, ...declared] : []
      add({
        value: `${group.provider}/${model.id}`,
        provider: group.provider,
        model: model.id,
        // The menu sets a name's provider back and shows the model.
        name: `${group.name}/${model.name}`,
        group: group.name,
        efforts,
        effort:
          efforts.length === 0
            ? null
            : (chosen(group.provider, model.id, declared) ??
              (group.effort && declared.includes(group.effort) ? group.effort : DEFAULT_LEVEL)),
      })
    }
  }
  return choices
}

/**
 * The models dsh lists itself, as the menu offers them: the same models under the same names as
 * in dsh's own pickers. The models of the DeepSeek route the home is signed in on keep their bare
 * ids, as sessions before stored them; every other model is named with its route.
 */
export function listedModelChoices(
  listed: readonly ListedModel[],
  routes: Routes,
  signedIn: Provider | null,
): ModelChoice[] {
  const own: string = signedIn ?? 'deepseek-official'
  const level = (id: string): string => (id === '' ? DEFAULT_LEVEL : id)
  const choices: ModelChoice[] = []
  for (const model of listed) {
    const bare = model.provider === own
    const value = bare ? model.model : `${model.provider}/${model.model}`
    if (choices.some((choice) => choice.value === value)) continue
    const efforts = model.efforts.map((effort) => level(effort.id))
    const saved = routes.selection
    const chosen =
      saved?.effort && saved.provider === model.provider && saved.model === model.model
        ? saved.effort
        : null
    choices.push({
      value,
      provider: model.provider,
      model: model.model,
      name: bare ? model.name : `${model.group}/${model.name}`,
      group: model.group,
      efforts,
      effort:
        chosen && efforts.includes(chosen)
          ? chosen
          : model.effort === null
            ? null
            : level(model.effort),
      effortNames: Object.fromEntries(
        model.efforts.map((effort) => [level(effort.id), effort.name]),
      ),
    })
  }
  return choices
}

/** The choice a route and model of dsh's stand for, such as the ones its events name. */
export function choiceOf(
  choices: readonly ModelChoice[],
  provider: string,
  model: string,
): ModelChoice | undefined {
  const own = DEEPSEEK_PROVIDERS.includes(provider)
  return choices.find(
    (choice) =>
      choice.model === model && (choice.provider === provider || (own && choice.provider === null)),
  )
}

/** The model a new session starts on: the one dsh's own pages chose, else the first listed. */
export function startChoice(choices: readonly ModelChoice[], routes: Routes): ModelChoice | null {
  const chosen = routes.selection
  return (chosen && choiceOf(choices, chosen.provider, chosen.model)) || choices[0] || null
}

/** What the session's choices are now, which the mode, model and effort menus show. */
export interface Choices {
  /** A model choice's value. */
  model: string
  effort: string | null
  preset: string
  plan: boolean
}

export const MODE_KEYS = {
  plan: 'plan',
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'fullAccess',
} as const

function levelName(level: string, model: ModelChoice): string {
  const named = NAMED_LEVELS.find((known) => known === level)
  return named ? t(`dsh.effort.${named}`) : (model.effortNames?.[level] ?? level)
}

export function configOptions(choices: Choices, models: readonly ModelChoice[]): ConfigOption[] {
  const model = models.find((choice) => choice.value === choices.model)
  const grouped = new Set(models.map((choice) => choice.group)).size > 1
  const options: ConfigOption[] = [
    {
      id: CONFIG.mode,
      name: t('dsh.mode.name'),
      category: 'mode',
      type: 'select',
      value: choices.plan ? 'plan' : choices.preset,
      choices: MODES.map((mode) => ({
        value: mode,
        name: t(`dsh.mode.${MODE_KEYS[mode]}`),
        description: t(`dsh.mode.${MODE_KEYS[mode]}Description`),
      })),
    },
    {
      id: CONFIG.model,
      name: t('dsh.model'),
      category: 'model',
      type: 'select',
      value: choices.model,
      choices: models.map((choice) => ({
        value: choice.value,
        name: choice.name,
        modelId: choice.model,
        ...(grouped ? { group: choice.group } : {}),
      })),
      idleOnly: true,
    },
  ]
  if (model && model.efforts.length > 0 && choices.effort !== null) {
    options.push({
      id: CONFIG.effort,
      name: t('dsh.effort.name'),
      category: 'thought_level',
      type: 'select',
      value: choices.effort,
      choices: model.efforts.map((effort) => ({ value: effort, name: levelName(effort, model) })),
      idleOnly: true,
    })
  }
  return options
}

/** The commands that take a running session from one mode to the next, in order. */
export function modeCommands(
  from: { preset: string; plan: boolean },
  to: { preset: string; plan: boolean },
): string[] {
  const commands: string[] = []
  if (from.preset !== to.preset) commands.push(`/permission ${to.preset}`)
  if (from.plan !== to.plan) commands.push(to.plan ? '/plan' : '/plan off')
  return commands
}
