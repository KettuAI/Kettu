// A DeepSeek Harness session's options: its model and reasoning effort, which its process starts
// with, and its mode, which is dsh's permission preset or its plan mode.

import type { ConfigOption } from '@shared/thread'
import { t } from '../i18n'

export const CONFIG = { mode: 'mode', model: 'model', effort: 'effort' } as const

/** The models dsh 0.2.2 lists for its DeepSeek routes, by id. */
const MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
] as const

const EFFORTS = ['off', 'low', 'high', 'max'] as const

/** The modes, in the menu's order: plan mode, then the permission presets from narrow to broad. */
export const MODES = ['plan', 'read-only', 'workspace-write', 'danger-full-access'] as const

export type Mode = (typeof MODES)[number]

export const DEFAULT_MODEL = 'deepseek-flash'
export const DEFAULT_EFFORT = 'high'
export const DEFAULT_PRESET = 'workspace-write'

export function isModel(value: string): boolean {
  return MODELS.some((model) => model.id === value)
}

export function isEffort(value: string): boolean {
  return (EFFORTS as readonly string[]).includes(value)
}

export function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value)
}

/** What the session's choices are now, which the mode, model and effort menus show. */
export interface Choices {
  model: string
  effort: string
  preset: string
  plan: boolean
}

export const MODE_KEYS = {
  plan: 'plan',
  'read-only': 'readOnly',
  'workspace-write': 'workspaceWrite',
  'danger-full-access': 'fullAccess',
} as const

export function configOptions(choices: Choices): ConfigOption[] {
  return [
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
      choices: MODELS.map((model) => ({ value: model.id, name: model.name, modelId: model.id })),
      idleOnly: true,
    },
    {
      id: CONFIG.effort,
      name: t('dsh.effort.name'),
      category: 'thought_level',
      type: 'select',
      value: choices.effort,
      choices: EFFORTS.map((effort) => ({ value: effort, name: t(`dsh.effort.${effort}`) })),
      idleOnly: true,
    },
  ]
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
