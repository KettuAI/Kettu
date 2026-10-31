import { describe, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import { mainModels, numberedModel, shownChoice, shownValue, splitModels } from './model-list'

const choices = (count: number): NonNullable<ConfigOption['choices']> =>
  Array.from({ length: count }, (_, i) => ({ value: `m${i + 1}`, name: `Model ${i + 1}` }))

const values = (list: NonNullable<ConfigOption['choices']>) => list.map((c) => c.value)

// Claude Code's shape: Default stands for Opus, and the pinned versions are older.
const marked: NonNullable<ConfigOption['choices']> = [
  { value: 'default', name: 'Default (recommended)', shownAs: 'opus' },
  { value: 'opus', name: 'Opus' },
  { value: 'sonnet', name: 'Sonnet' },
  { value: 'haiku', name: 'Haiku' },
  { value: 'claude-opus-5', name: 'Opus 5', older: true },
  { value: 'claude-sonnet-5', name: 'Sonnet 5', older: true },
]

describe('splitModels', () => {
  it('puts the marked older models under More models and leaves out the ones shown as another', () => {
    const { current, older } = splitModels(marked)
    expect(values(current)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(values(older)).toEqual(['claude-opus-5', 'claude-sonnet-5'])
  })

  it('splits after the first four when the agent marks nothing', () => {
    const { current, older } = splitModels(choices(6))
    expect(values(current)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(values(older)).toEqual(['m5', 'm6'])
  })
})

describe('shownValue', () => {
  it('maps a model to the one it is shown as', () => {
    expect(shownValue(marked, 'default')).toBe('opus')
    expect(shownChoice(marked, 'default')?.name).toBe('Opus')
  })

  it('keeps any other value', () => {
    expect(shownValue(marked, 'sonnet')).toBe('sonnet')
    expect(shownValue(marked, 'gone')).toBe('gone')
    expect(shownValue(marked, undefined)).toBeUndefined()
  })
})

describe('mainModels', () => {
  it('shows the first four in the agent order', () => {
    expect(values(mainModels(choices(6), 'm1'))).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('adds the current model as a fifth row when it is not among the four', () => {
    expect(values(mainModels(choices(6), 'm6'))).toEqual(['m1', 'm2', 'm3', 'm4', 'm6'])
  })

  it('does not repeat a current model that is among the four', () => {
    expect(values(mainModels(choices(6), 'm3'))).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('shows every model when the agent has fewer than four', () => {
    expect(values(mainModels(choices(3), 'm2'))).toEqual(['m1', 'm2', 'm3'])
    expect(values(mainModels(choices(3), 'm9'))).toEqual(['m1', 'm2', 'm3'])
  })

  it('shows the first four when nothing is chosen yet', () => {
    expect(values(mainModels(choices(6), undefined))).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('shows the current models, with an older chosen one after them', () => {
    expect(values(mainModels(marked, 'default'))).toEqual(['opus', 'sonnet', 'haiku'])
    expect(values(mainModels(marked, 'claude-opus-5'))).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'claude-opus-5',
    ])
  })
})

describe('numberedModel', () => {
  it('maps 1 to 4 to the first four models', () => {
    const list = choices(6)
    expect([1, 2, 3, 4].map((n) => numberedModel(list, String(n))?.value)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
    ])
  })

  it('has no model for another key', () => {
    const list = choices(6)
    expect(numberedModel(list, '5')).toBeUndefined()
    expect(numberedModel(list, '0')).toBeUndefined()
    expect(numberedModel(list, 'a')).toBeUndefined()
    expect(numberedModel(choices(2), '3')).toBeUndefined()
  })
})
