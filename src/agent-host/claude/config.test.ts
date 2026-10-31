import { describe, expect, it } from 'vitest'
import { buildConfig } from './config'
import type { ModelInfo } from './sdk'

const row = (value: string, displayName: string, resolvedModel?: string): ModelInfo => ({
  value,
  displayName,
  description: '',
  ...(resolvedModel ? { resolvedModel } : {}),
})

const choices = { mode: 'default', model: 'default', effort: 'default', fast: false }

const modelChoices = (models: ModelInfo[]) =>
  buildConfig(models, choices, ['default']).find((o) => o.id === 'model')?.choices

describe('the model option', () => {
  it('marks the pinned models older than the aliases, and shows Default as its alias', () => {
    expect(
      modelChoices([
        row('default', 'Default (recommended)', 'claude-opus-5-5'),
        row('opus', 'Opus 5.5', 'claude-opus-5-5'),
        row('sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5'),
        row('claude-opus-4-8', 'Opus 4.8', 'claude-opus-4-8'),
      ]),
    ).toEqual([
      { value: 'default', name: 'Default (recommended)', shownAs: 'opus' },
      { value: 'opus', name: 'Opus 5.5' },
      { value: 'sonnet', name: 'Sonnet 5.5' },
      { value: 'claude-opus-4-8', name: 'Opus 4.8', older: true },
    ])
  })

  it('marks nothing when the SDK names no resolved models', () => {
    expect(
      modelChoices([row('default', 'Default (recommended)'), row('claude-opus-4-8', 'Opus 4.8')]),
    ).toEqual([
      { value: 'default', name: 'Default (recommended)' },
      { value: 'claude-opus-4-8', name: 'Opus 4.8' },
    ])
  })

  it('keeps Default as its own row when no alias resolves to the same model', () => {
    expect(
      modelChoices([
        row('default', 'Default (recommended)', 'claude-sonnet-5-5'),
        row('opus', 'Opus 5.5', 'claude-opus-5-5'),
      ]),
    ).toEqual([
      { value: 'default', name: 'Default (recommended)' },
      { value: 'opus', name: 'Opus 5.5' },
    ])
  })
})
