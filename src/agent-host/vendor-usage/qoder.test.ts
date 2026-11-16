import { describe, expect, it } from 'vitest'
import { parseQoderUsage } from './qoder'

describe('Qoder usage reply', () => {
  it('maps recorded credits and add-on packs', () => {
    const result = parseQoderUsage(
      {
        accountUsage: {
          totalUsagePercentage: 10,
          userQuota: { used: 10, total: 100, remaining: 90, unit: 'credits' },
          addOnQuota: { used: 2, total: 10, remaining: 8, unit: 'credits' },
        },
      },
      10,
    )
    expect(result?.limits[0].amount).toEqual({ used: 10, total: 100, unit: 'credits' })
    expect(result?.balances[0].amount).toBe(8)
  })
})
