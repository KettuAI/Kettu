import { describe, expect, it } from 'vitest'
import { LIMIT_FILL, LIMIT_TEXT, limitLevel } from './plan-limit'

const used = (usedPercent: number | null, state: 'ok' | 'warning' | 'reached' = 'ok') =>
  limitLevel({ usedPercent, state })

describe('limitLevel', () => {
  it('reads under 70% as ok, 70 to 89% as warn and 90% or more as bad', () => {
    expect(used(0)).toBe('ok')
    expect(used(69)).toBe('ok')
    expect(used(70)).toBe('warn')
    expect(used(89)).toBe('warn')
    expect(used(90)).toBe('bad')
    expect(used(100)).toBe('bad')
  })

  it('goes by the whole percentage the bar shows', () => {
    expect(used(69.4)).toBe('ok')
    expect(used(69.5)).toBe('warn')
    expect(used(89.4)).toBe('warn')
    expect(used(89.5)).toBe('bad')
  })

  it('reads a reached limit as bad at any percentage, and an unknown one as ok', () => {
    expect(used(12, 'reached')).toBe('bad')
    expect(used(null, 'reached')).toBe('bad')
    expect(used(null)).toBe('ok')
    expect(used(40, 'warning')).toBe('ok')
  })
})

describe('the limit classes', () => {
  it('fills the bar from the limit tokens', () => {
    expect(LIMIT_FILL).toEqual({ ok: 'bg-limit-ok', warn: 'bg-limit-warn', bad: 'bg-limit-bad' })
  })

  it('colors the percentage with the text tones that read on every surface', () => {
    expect(LIMIT_TEXT).toEqual({ ok: 'text-tertiary', warn: 'text-warning', bad: 'text-danger' })
  })
})
