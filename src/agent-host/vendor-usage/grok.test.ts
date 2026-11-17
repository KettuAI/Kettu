import { describe, expect, it } from 'vitest'
import billing from './fixtures/grok-billing.json'
import signedIn from './fixtures/grok-auth-info-signed-in.json'
import signedOut from './fixtures/grok-auth-info-signed-out.json'
import { parseGrokAuthInfo, parseGrokBilling } from './grok'

const NOW = Date.parse('2026-11-17T15:00:00Z')

describe('Grok sign-in reply', () => {
  it('reads a recorded signed-out reply as signed out', () => {
    expect(parseGrokAuthInfo(signedOut)).toEqual({ state: 'unauthenticated', account: null })
  })

  it('reads a recorded signed-in reply with its email and no plan yet', () => {
    expect(parseGrokAuthInfo(signedIn)).toEqual({
      state: 'authenticated',
      account: { kind: 'account', label: '', email: 'user@example.com' },
    })
  })

  it('names an API key sign-in', () => {
    expect(parseGrokAuthInfo({ ...signedIn, methodId: 'xai.api_key' })?.account).toEqual({
      kind: 'api_key',
      label: 'xAI API key',
      email: 'user@example.com',
    })
  })

  it('refuses a reply it cannot read instead of calling it signed out', () => {
    expect(parseGrokAuthInfo({})).toBeNull()
    expect(parseGrokAuthInfo({ methodId: 7 })).toBeNull()
    expect(parseGrokAuthInfo(null)).toBeNull()
  })
})

describe('Grok billing reply', () => {
  it('maps a recorded weekly period with nothing used yet', () => {
    const result = parseGrokBilling(billing, NOW)
    expect(result?.tier).toBe('X Premium')
    expect(result?.limits).toEqual([
      {
        window: 'seven_day',
        label: 'Weekly',
        usedPercent: 0,
        resetsAt: Date.parse('2026-11-24T12:26:43.231Z'),
        state: 'ok',
        observedAt: NOW,
      },
    ])
    // A zero prepaid balance is not shown.
    expect(result?.balances).toEqual([])
  })

  it('reads the used percent, on-demand spend and prepaid balance in cents', () => {
    const result = parseGrokBilling(
      {
        ...billing,
        config: {
          ...billing.config,
          creditUsagePercent: 42,
          onDemandUsed: { val: '250' },
          onDemandCap: { val: '1000' },
          prepaidBalance: { val: 1240 },
        },
      },
      NOW,
    )
    expect(result?.limits[0].usedPercent).toBe(42)
    expect(result?.limits[1]).toMatchObject({
      window: 'on_demand',
      usedPercent: 25,
      amount: { used: 2.5, total: 10, unit: 'USD' },
    })
    expect(result?.balances).toEqual([{ label: 'Prepaid balance', amount: 12.4, currency: 'USD' }])
  })

  it('names a monthly period', () => {
    const monthly = {
      ...billing,
      config: { ...billing.config, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' } },
    }
    expect(parseGrokBilling(monthly, NOW)?.limits[0]).toMatchObject({
      window: 'monthly',
      resetsAt: Date.parse('2026-11-24T12:26:43.231Z'),
    })
  })

  it('refuses the shape it no longer reads', () => {
    expect(parseGrokBilling({ creditUsagePercent: 42, prepaidBalance: 12.4 }, NOW)).toBeNull()
    expect(
      parseGrokBilling({ config: { ...billing.config, creditUsagePercent: 'lots' } }, NOW),
    ).toBeNull()
  })
})
