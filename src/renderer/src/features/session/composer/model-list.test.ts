import { describe, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import { mainModels, numberedModel } from './model-list'

const choices = (count: number): NonNullable<ConfigOption['choices']> =>
  Array.from({ length: count }, (_, i) => ({ value: `m${i + 1}`, name: `Model ${i + 1}` }))

const values = (list: NonNullable<ConfigOption['choices']>) => list.map((c) => c.value)

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
