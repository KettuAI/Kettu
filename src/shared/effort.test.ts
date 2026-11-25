import { describe, expect, it } from 'vitest'
import { carriedEffort, carriedLevel } from './effort'
import type { ConfigOption } from './thread'

const level = (values: string[], value = values[0]!): ConfigOption => ({
  id: 'thought_level',
  name: 'Thinking Level',
  category: 'thought_level',
  type: 'select',
  value,
  choices: values.map((v) => ({ value: v, name: v })),
})

describe('the effort a model change carries', () => {
  it('keeps an effort the new model offers', () => {
    expect(carriedEffort(['low', 'medium', 'high'], 'medium')).toBe('medium')
  })

  it('moves an effort the new model lacks to the nearest lower level it offers', () => {
    expect(carriedEffort(['low', 'medium', 'high'], 'xhigh')).toBe('high')
    expect(carriedEffort(['low', 'high'], 'max')).toBe('high')
    expect(carriedEffort(['low', 'medium', 'high', 'xhigh'], 'ultra')).toBe('xhigh')
    expect(carriedEffort(['minimal', 'high'], 'medium')).toBe('minimal')
    // The order is the levels', not the list's.
    expect(carriedEffort(['high', 'low', 'medium'], 'xhigh')).toBe('high')
  })

  it("leaves the model's default when it offers nothing lower or no level is named alike", () => {
    expect(carriedEffort(['high', 'xhigh'], 'low')).toBeNull()
    expect(carriedEffort([], 'xhigh')).toBeNull()
    expect(carriedEffort(['low', 'high'], 'turbo')).toBeNull()
    expect(carriedEffort(['default', 'low'], 'default')).toBe('default')
  })

  it("reads a model's level option, and none for a model without one", () => {
    expect(carriedLevel(level(['low', 'medium', 'high']), 'xhigh')).toBe('high')
    expect(carriedLevel(level(['low', 'medium', 'high', 'xhigh']), 'xhigh')).toBe('xhigh')
    expect(carriedLevel(undefined, 'xhigh')).toBeNull()
  })
})
