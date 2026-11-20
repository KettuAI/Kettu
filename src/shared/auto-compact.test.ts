import { describe, expect, it } from 'vitest'
import { compactLabel, compactSpec, compactSteps, parseCompactValue } from './auto-compact'

describe('auto-compact values', () => {
  it('reads tokens written with or without K and M, and whole percents', () => {
    expect(parseCompactValue('trigger', '272K')).toBe(272_000)
    expect(parseCompactValue('window', '272k')).toBe(272_000)
    expect(parseCompactValue('window', '272,000')).toBe(272_000)
    expect(parseCompactValue('window', '1.5M')).toBe(1_500_000)
    expect(parseCompactValue('reserve', '16000')).toBe(16_000)
    expect(parseCompactValue('percent', '85%')).toBe(85)
    expect(parseCompactValue('percent', ' 85 ')).toBe(85)
    expect(parseCompactValue('percent', '85.5')).toBeNull()
    expect(parseCompactValue('window', '272 tokens')).toBeNull()
    expect(parseCompactValue('window', '-1')).toBeNull()
  })

  it('writes values short, and offers 272K among the steps in range', () => {
    expect(compactLabel('window', 272_000)).toBe('272K')
    expect(compactLabel('window', 1_000_000)).toBe('1M')
    expect(compactLabel('percent', 55.5)).toBe('55.5%')
    expect(compactSteps(compactSpec('claude-code')!)).toContain(272_000)
    expect(compactSteps(compactSpec('kimi')!)).toEqual([50, 60, 70, 75, 80, 85, 90, 95])
    expect(compactSpec('cline')).toBeNull()
  })
})
