import { describe, expect, it } from 'vitest'
import { buildConfig, type SessionChoices } from './config'
import type { ModelInfo } from './sdk'

const MODELS: ModelInfo[] = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: 'For complex work and everyday tasks',
  },
  {
    value: 'fable',
    resolvedModel: 'claude-fable-5-2',
    displayName: 'Fable 5.2',
    description: 'For your toughest challenges',
  },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Most capable' },
]

const choices = (model: string): SessionChoices => ({
  mode: 'default',
  model,
  effort: 'default',
  fast: false,
  ultracode: 'default',
})

function modelChoices(models: readonly ModelInfo[], model: string) {
  const option = buildConfig(models, choices(model), ['default']).find((o) => o.id === 'model')
  return option?.choices ?? []
}

describe('the model choices of a Claude Code session', () => {
  it('shows a full model id an alias resolves to as that alias', () => {
    const listed = modelChoices(
      [
        ...MODELS,
        {
          value: 'claude-fable-5-2',
          resolvedModel: 'claude-fable-5-2',
          displayName: 'Fable 5.2',
          description: 'For your toughest challenges',
        },
      ],
      'claude-fable-5-2',
    )
    const rows = listed.filter((c) => !c.shownAs)
    expect(rows.filter((c) => c.name === 'Fable 5.2').map((c) => c.value)).toEqual(['fable'])
    expect(listed.find((c) => c.value === 'claude-fable-5-2')?.shownAs).toBe('fable')
  })

  it('shows a settings model left out of the list as the alias that resolves to it', () => {
    const listed = modelChoices(MODELS, 'claude-fable-5-2')
    expect(listed.find((c) => c.value === 'claude-fable-5-2')?.shownAs).toBe('fable')
  })

  it('keeps a full model id no alias resolves to as a row of its own', () => {
    const listed = modelChoices(MODELS, 'claude-fable-5-1')
    expect(listed.find((c) => c.value === 'claude-fable-5-1')?.shownAs).toBeUndefined()
  })

  it('still shows Default as the alias of the same model', () => {
    const listed = modelChoices(MODELS, 'default')
    expect(listed.find((c) => c.value === 'default')?.shownAs).toBe('opus')
    expect(listed.find((c) => c.value === 'opus')?.shownAs).toBeUndefined()
  })
})
