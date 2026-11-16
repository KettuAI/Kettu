import { describe, expect, it, vi } from 'vitest'
import { parseFactoryLimits, readFactoryLimits } from './droid'

const SECRET = 'fk-factory-secret-123'
const NOW = Date.parse('2026-11-15T00:00:00Z')

// The shape Droid's /status reads from `/api/billing/limits`.
const LIMITS = {
  limits: {
    standard: {
      fiveHour: { usedPercent: 12.5, windowEnd: '2026-11-15T04:00:00Z' },
      weekly: { usedPercent: 40, windowEnd: 1_763_600_000_000 },
      monthly: { usedPercent: 100, windowEnd: '2026-12-01T00:00:00Z' },
    },
    core: { fiveHour: { usedPercent: 3, windowEnd: '2026-11-15T04:00:00Z' } },
  },
  extraUsageBalanceCents: 1250,
  extraUsageAllowed: true,
}

describe('Factory limits reply', () => {
  it('maps the standard windows and the extra usage balance', () => {
    const usage = parseFactoryLimits(LIMITS, NOW)!
    expect(usage.limits.map((l) => [l.window, l.usedPercent, l.state])).toEqual([
      ['five_hour', 12.5, 'ok'],
      ['seven_day', 40, 'ok'],
      ['monthly', 100, 'reached'],
    ])
    expect(usage.limits[1]!.resetsAt).toBe(1_763_600_000_000)
    expect(usage.balances).toEqual([{ label: 'Extra usage', amount: 12.5, currency: 'USD' }])
  })

  it('reads nothing from a reply without windows or a balance', () => {
    expect(parseFactoryLimits({ limits: {} }, NOW)).toBeNull()
  })
})

describe('reading with FACTORY_API_KEY', () => {
  it('sends the key only to Factory limits endpoint and returns none of it', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...LIMITS, key: SECRET })))
    const usage = await readFactoryLimits({
      env: { FACTORY_API_KEY: SECRET },
      home: '/unused',
      platform: 'linux',
      now: NOW,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.factory.ai/api/billing/limits')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.stringify(usage)).not.toContain(SECRET)
  })

  it('fails without sending anything when no key is set', async () => {
    const fetch = vi.fn()
    await expect(
      readFactoryLimits({
        env: { FACTORY_API_KEY: '  ' },
        home: '/unused',
        platform: 'linux',
        now: NOW,
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow('FACTORY_API_KEY')
    expect(fetch).not.toHaveBeenCalled()
  })
})
