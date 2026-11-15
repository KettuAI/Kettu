import { describe, expect, it } from 'vitest'
import { parseGrokBilling } from './grok'

describe('Grok billing reply', () => {
  it('maps a recorded weekly usage and prepaid balance', () => {
    const result = parseGrokBilling(
      {
        creditUsagePercent: 42,
        currentPeriod: { type: 'weekly' },
        prepaidBalance: 12.4,
        subscription_tier: 'SuperGrok',
      },
      10,
    )
    expect(result?.limits[0].usedPercent).toBe(42)
    expect(result?.balances[0]).toEqual({ label: 'Prepaid balance', amount: 12.4, currency: 'USD' })
    expect(result?.tier).toBe('SuperGrok')
  })
})
