import { describe, expect, it } from 'vitest'
import { parseAuggieAccount } from './auggie'

describe('Auggie account reply', () => {
  it('maps recorded remaining cycle credits', () => {
    const result = parseAuggieAccount(
      {
        planName: 'Pro',
        usageUnit: 'credits',
        amountRemaining: 70,
        amountIncludedPerCycle: 100,
        billingCycleEndDate: '2026-12-01T00:00:00Z',
      },
      10,
    )
    expect(result?.tier).toBe('Pro')
    expect(result?.limits[0].amount?.used).toBe(30)
  })
})
