// Pi model and thinking-level config options: verifies provider grouping, stable values,
// modelId metadata, single-provider fallback, and scope handling.

import { describe, expect, it } from 'vitest'
import { CONFIG, configOptions, modelValue } from './options'
import type { PiModel } from './protocol'

function modelOption(
  models: readonly PiModel[],
  current: PiModel | null = models[0] ?? null,
  scope: ReadonlySet<string> | null = null,
) {
  return configOptions({
    model: current,
    level: 'high',
    models,
    levels: ['low', 'high'],
    scope,
  }).find((option) => option.id === CONFIG.model)
}

describe('pi configOptions model provider grouping', () => {
  it('groups multi-provider models contiguously and tags each choice with group and modelId', () => {
    const models: PiModel[] = [
      { provider: 'provider1', id: 'gpt-6.1-sol', name: 'gpt-6.1-sol' },
      { provider: 'provider2', id: 'gpt-6.1-sol', name: 'gpt-6.1-sol' },
      { provider: 'provider1', id: 'gpt-6.2-sol', name: 'gpt-6.2-sol' },
      { provider: 'provider2', id: 'gpt-6.2-sol', name: 'gpt-6.2-sol' },
    ]
    const option = modelOption(models, models[0])
    expect(option).toMatchObject({
      id: CONFIG.model,
      category: 'model',
      type: 'select',
      value: 'provider1/gpt-6.1-sol',
      choices: [
        {
          value: 'provider1/gpt-6.1-sol',
          name: 'provider1/gpt-6.1-sol',
          modelId: 'gpt-6.1-sol',
          group: 'provider1',
        },
        {
          value: 'provider1/gpt-6.2-sol',
          name: 'provider1/gpt-6.2-sol',
          modelId: 'gpt-6.2-sol',
          group: 'provider1',
        },
        {
          value: 'provider2/gpt-6.1-sol',
          name: 'provider2/gpt-6.1-sol',
          modelId: 'gpt-6.1-sol',
          group: 'provider2',
        },
        {
          value: 'provider2/gpt-6.2-sol',
          name: 'provider2/gpt-6.2-sol',
          modelId: 'gpt-6.2-sol',
          group: 'provider2',
        },
      ],
    })
  })

  it('omits group for single-provider lists while preserving value, name, and modelId', () => {
    const models: PiModel[] = [
      { provider: 'openrouter', id: 'openai/gpt-6.1-sol', name: 'openai/gpt-6.1-sol' },
      { provider: 'openrouter', id: 'anthropic/claude-opus-4-8', name: 'Claude 4.8 / Fast' },
    ]
    const option = modelOption(models, models[0])
    expect(option?.choices).toEqual([
      {
        value: 'openrouter/openai/gpt-6.1-sol',
        name: 'openrouter/openai/gpt-6.1-sol',
        modelId: 'openai/gpt-6.1-sol',
      },
      {
        value: 'openrouter/anthropic/claude-opus-4-8',
        name: 'openrouter/Claude 4.8 / Fast',
        modelId: 'anthropic/claude-opus-4-8',
      },
    ])
  })

  it('keeps an unlisted active model grouped with its provider and falls back to id when name is blank', () => {
    const listed: PiModel[] = [
      { provider: 'provider1', id: 'm1', name: '   ' },
      { provider: 'provider2', id: 'm2', name: 'Model Two' },
    ]
    const active: PiModel = { provider: 'provider2', id: 'legacy/v1' }
    const option = modelOption(listed, active)
    expect(option?.value).toBe(modelValue(active))
    expect(option?.choices).toEqual([
      {
        value: 'provider2/legacy/v1',
        name: 'provider2/legacy/v1',
        modelId: 'legacy/v1',
        group: 'provider2',
      },
      {
        value: 'provider2/m2',
        name: 'provider2/Model Two',
        modelId: 'm2',
        group: 'provider2',
      },
      {
        value: 'provider1/m1',
        name: 'provider1/m1',
        modelId: 'm1',
        group: 'provider1',
      },
    ])
  })

  it('updates grouping when a model scope narrows the list to a single provider and drops invalid models', () => {
    const models: PiModel[] = [
      { provider: '', id: 'missing-provider', name: 'Ignored' },
      { provider: 'provider1', id: '', name: 'Ignored' },
      { provider: 'provider1', id: 'gpt-6.1-sol', name: 'gpt-6.1-sol' },
      { provider: 'provider2', id: 'gpt-6.2-sol', name: 'gpt-6.2-sol' },
    ]
    const narrowed = modelOption(models, models[2], new Set(['provider1/gpt-6.1-sol']))
    expect(narrowed?.choices).toEqual([
      {
        value: 'provider1/gpt-6.1-sol',
        name: 'provider1/gpt-6.1-sol',
        modelId: 'gpt-6.1-sol',
      },
    ])

    const empty = modelOption([{ provider: '', id: 'bad' }], null)
    expect(empty).toBeUndefined()
  })
})
