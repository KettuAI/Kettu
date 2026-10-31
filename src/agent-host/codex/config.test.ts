import { describe, expect, it } from 'vitest'
import { buildConfig, type Settings } from './config'
import type { Model } from './protocol'

const model = (id: string, extra: Partial<Model> = {}): Model => ({
  id,
  displayName: id,
  description: '',
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  isDefault: false,
  ...extra,
})

const settings: Settings = {
  mode: 'agent',
  collaboration: 'default',
  model: 'gpt-6.1-sol',
  effort: null,
  fast: false,
}

const older = (models: Model[]) =>
  buildConfig(settings, models)
    .find((o) => o.id === 'model')
    ?.choices?.filter((c) => c.older)
    .map((c) => c.value)

describe('the model option', () => {
  it('marks all but the newest version of each family older', () => {
    expect(
      older([
        model('gpt-6.1-sol'),
        model('gpt-6-astra'),
        model('gpt-6.1-terra'),
        model('gpt-6-sol'),
        model('gpt-6-luna'),
        model('gpt-5.6-sol'),
        model('gpt-5.6-terra'),
        model('gpt-5.6-luna'),
      ]),
    ).toEqual(['gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
  })

  it('marks a model Codex names an upgrade for, and leaves an id of another shape', () => {
    expect(
      older([
        model('gpt-6.1-sol'),
        model('codex-mini', { upgrade: 'gpt-6.1-sol' }),
        model('o9-preview'),
        model('gpt-6.10-sol'),
      ]),
    ).toEqual(['gpt-6.1-sol', 'codex-mini'])
  })
})
