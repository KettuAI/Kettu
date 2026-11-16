import { describe, expect, it } from 'vitest'
import { parseKiloProfile } from './kilo'

describe('Kilo profile reply', () => {
  it('maps recorded prepaid credits and pass', () => {
    const result = parseKiloProfile({
      balance: { balance: 2.5 },
      kiloPass: {
        currentPeriodBaseCreditsUsd: 100,
        currentPeriodUsageUsd: 50,
        currentPeriodBonusCreditsUsd: 10,
      },
    })
    expect(result?.balances[0]).toEqual({ label: 'Prepaid balance', amount: 2.5, currency: 'USD' })
    expect(result?.limits[0].amount).toEqual({ used: 50, total: 110, unit: 'USD' })
  })
})
