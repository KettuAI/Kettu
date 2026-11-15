import { describe, expect, it } from 'vitest'
import { parseCopilotQuota } from './copilot'

describe('Copilot quota reply', () => {
  it('maps recorded premium request counts', () => {
    const result = parseCopilotQuota(
      {
        quota_snapshots: {
          premium_interactions: { entitlement: 300, quota_remaining: 288, percent_remaining: 96 },
        },
      },
      10,
    )
    expect(result?.limits[0].amount).toEqual({ used: 12, total: 300, unit: 'requests' })
  })
})
