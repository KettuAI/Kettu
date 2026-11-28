import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exactTurnCost, turnCost } from './format'
import { i18n } from './i18n'

describe('turnCost and exactTurnCost', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('formats turn costs across magnitude bands without rounding small positive amounts to $0.00', () => {
    expect(turnCost(0)).toBe('$0.00')
    expect(turnCost(0.00004)).toBe('<$0.0001')
    expect(turnCost(0.0008)).toBe('$0.0008')
    expect(turnCost(0.0042)).toBe('$0.0042')
    expect(turnCost(0.042)).toBe('$0.042')
    expect(turnCost(0.12)).toBe('$0.12')
    expect(turnCost(1.256)).toBe('$1.26')
    expect(turnCost(123.45)).toBe('$123')
  })

  it('formats exact tooltip costs with higher sub-dollar precision', () => {
    expect(exactTurnCost(0)).toBe('$0.00')
    expect(exactTurnCost(0.000004)).toBe('<$0.00001')
    expect(exactTurnCost(0.04238)).toBe('$0.04238')
    expect(exactTurnCost(2.5)).toBe('$2.50')
  })
})
