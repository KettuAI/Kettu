// A Cline session's options, under the ids its ACP mode gave them, so a session made over ACP
// keeps its choices: the provider, the model, plan or act mode, and running tools without asking.
// Thinking is the SDK's own, offered for a model that reasons.

import type { ConfigOption } from '@shared/thread'
import { t } from '../i18n'
import type { ClineModel, ClineProvider, ClineSettings } from './protocol'

export const CONFIG = {
  provider: 'provider',
  model: 'model',
  mode: 'mode',
  thinking: 'thinking',
  autoApprove: 'auto_approve',
} as const

const MODES = ['plan', 'act'] as const
const THINKING = { on: 'on', off: 'off' } as const

export function isMode(value: string): value is ClineSettings['mode'] {
  return (MODES as readonly string[]).includes(value)
}

export interface Choices {
  settings: ClineSettings
  providers: readonly ClineProvider[]
  models: readonly ClineModel[]
}

/** The model the session runs, among those its provider lists. */
export function currentModel(choices: Choices): ClineModel | null {
  return choices.models.find((model) => model.id === choices.settings.model) ?? null
}

export function configOptions(choices: Choices): ConfigOption[] {
  const { settings } = choices
  // Only the providers Cline can run; the session's own stays listed though it lost its sign-in.
  const providers = choices.providers.filter(
    (provider) => provider.ready || provider.id === settings.provider,
  )
  const models = choices.models.some((model) => model.id === settings.model)
    ? choices.models
    : [
        { id: settings.model, name: settings.model, reasoning: false, images: false },
        ...choices.models,
      ]
  const options: ConfigOption[] = [
    {
      id: CONFIG.mode,
      name: t('cline.mode.name'),
      category: 'mode',
      type: 'select',
      value: settings.mode,
      choices: MODES.map((mode) => ({
        value: mode,
        name: t(`cline.mode.${mode}`),
        description: t(`cline.mode.${mode}Description`),
      })),
      idleOnly: true,
    },
    {
      id: CONFIG.model,
      name: t('cline.model'),
      category: 'model',
      type: 'select',
      value: settings.model,
      choices: models.map((model) => ({
        value: model.id,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        modelId: model.id,
      })),
    },
  ]
  if (currentModel(choices)?.reasoning) {
    options.push({
      id: CONFIG.thinking,
      name: t('cline.thinking.name'),
      category: 'thought_level',
      type: 'select',
      value: settings.thinking ? THINKING.on : THINKING.off,
      choices: [
        { value: THINKING.off, name: t('cline.thinking.off') },
        { value: THINKING.on, name: t('cline.thinking.on') },
      ],
    })
  }
  if (providers.length > 1) {
    options.push({
      id: CONFIG.provider,
      name: t('cline.provider.name'),
      description: t('cline.provider.description'),
      category: 'other',
      type: 'select',
      value: settings.provider,
      choices: providers.map((provider) => ({ value: provider.id, name: provider.name })),
      idleOnly: true,
    })
  }
  options.push({
    id: CONFIG.autoApprove,
    name: t('cline.autoApprove.name'),
    description: t('cline.autoApprove.description'),
    category: 'other',
    type: 'boolean',
    value: settings.autoApprove,
  })
  return options
}

/** A change to an option as the settings it sets; null for a value the option does not take. */
export function settingsChange(
  optionId: string,
  value: string | boolean,
  choices: Choices,
): Partial<ClineSettings> | null {
  switch (optionId) {
    case CONFIG.mode:
      return typeof value === 'string' && isMode(value) ? { mode: value } : null
    case CONFIG.model:
      return typeof value === 'string' && value !== '' ? { model: value } : null
    case CONFIG.provider:
      return typeof value === 'string' && choices.providers.some((p) => p.id === value)
        ? { provider: value }
        : null
    case CONFIG.thinking:
      return value === THINKING.on || value === THINKING.off
        ? { thinking: value === THINKING.on }
        : null
    case CONFIG.autoApprove:
      // A client from before boolean options sends the word.
      return typeof value === 'boolean'
        ? { autoApprove: value }
        : value === 'true' || value === 'false'
          ? { autoApprove: value === 'true' }
          : null
    default:
      return null
  }
}
