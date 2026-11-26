import { describe, expect, it } from 'vitest'
import { findChips, type ChipContext } from './chips'

const ctx = (extra: Partial<ChipContext> = {}): ChipContext => ({
  commands: ['compact', 'status'],
  skills: ['code-review', 'security-audit', '$lint'],
  resolve: (token) => (token === 'auth.ts' ? { kind: 'file', path: 'src/auth.ts' } : null),
  ...extra,
})

describe('findChips with exclusive commands and stackable skills', () => {
  it('recognizes a leading exclusive command as command and ignores exclusive commands inline', () => {
    expect(findChips('/compact hello /status', ctx())).toEqual([
      { kind: 'command', from: 0, to: 8, name: 'compact' },
    ])
  })

  it('recognizes one or multiple skills at the start and inline as skill chips', () => {
    const text = '/code-review inspect @auth.ts and apply /security-audit with /$lint'
    const chips = findChips(text, ctx())
    expect(chips.map((c) => ({ kind: c.kind, from: c.from, to: c.to }))).toEqual([
      { kind: 'skill', from: 0, to: 12 },
      { kind: 'file', from: 21, to: 29 },
      { kind: 'skill', from: 40, to: 55 },
      { kind: 'skill', from: 61, to: 67 },
    ])
  })

  it('distinguishes a leading exclusive command from stacked skills in the same message', () => {
    const text = '/status /code-review /security-audit'
    const chips = findChips(text, ctx())
    expect(chips).toEqual([
      { kind: 'command', from: 0, to: 7, name: 'status' },
      { kind: 'skill', from: 8, to: 20, name: 'code-review' },
      { kind: 'skill', from: 21, to: 36, name: 'security-audit' },
    ])
  })

  it('keeps remaining skill chips intact when one skill is removed', () => {
    const text = '/code-review /security-audit check auth'
    const withoutFirst = text.slice(12) // " /security-audit check auth"
    expect(findChips(withoutFirst, ctx())).toEqual([
      { kind: 'skill', from: 1, to: 16, name: 'security-audit' },
    ])
  })

  it('does not turn URL paths into skill chips', () => {
    const text = 'See https://example.com/code-review and /security-audit'
    const chips = findChips(text, ctx())
    expect(chips.map((c) => c.kind)).toEqual(['link', 'skill'])
  })
})
