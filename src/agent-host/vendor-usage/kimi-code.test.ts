import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseKimiCodeUsage, readKimiCodeUsage } from './kimi-code'

const SECRET = 'kimi-access-secret-123'
const NOW = Date.parse('2026-11-15T00:00:00Z')

// The reply Kimi Code 2.6.2's own client parses, with a booster wallet.
const MANAGED = {
  usages: {
    limit_5h: { used_ratio: 0.4372, reset_time: '2026-11-15T03:00:00Z' },
    limit_month_total: { used_ratio: '0.25', reset_time: '2026-12-01T00:00:00Z' },
    limit_month_code: { used_ratio: 0.2 },
  },
  boosterWallet: {
    balance: { type: 'BOOSTER', amount: '10000000000', amountLeft: '5230000000' },
    monthlyChargeLimit: { priceInCents: 10000, currency: 'CNY' },
  },
}

describe('Kimi Code usage reply', () => {
  it('maps the shares to the 5-hour and monthly windows and the wallet to a balance', () => {
    const usage = parseKimiCodeUsage(MANAGED, NOW)!
    expect(usage.limits.map((l) => [l.window, Math.round(l.usedPercent!)])).toEqual([
      ['five_hour', 44],
      ['monthly', 25],
    ])
    expect(usage.limits[0]!.resetsAt).toBe(Date.parse('2026-11-15T03:00:00Z'))
    expect(usage.balances).toEqual([{ label: 'Extra usage', amount: 52.3, currency: 'CNY' }])
  })

  it('reads the counted windows of the older reply, the shares winning where both tell one', () => {
    const usage = parseKimiCodeUsage(
      {
        usage: { limit: '100', used: '12', resetTime: '2026-11-20T00:00:00Z' },
        limits: [
          {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: { limit: '100', remaining: '88', resetTime: '2026-11-15T02:00:00Z' },
          },
        ],
        usages: { limit_5h: { used_ratio: 0.5 } },
      },
      NOW,
    )!
    expect(usage.limits.map((l) => [l.window, l.usedPercent])).toEqual([
      ['five_hour', 50],
      ['seven_day', 12],
    ])
  })

  it('reads nothing from a reply that is not one', () => {
    expect(parseKimiCodeUsage('nope', NOW)).toBeNull()
    expect(parseKimiCodeUsage({}, NOW)).toEqual({ limits: [], balances: [] })
  })
})

describe('reading with Kimi Code stored sign-in', () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'kettu-kimi-'))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function token(file: string, expiresAt: number): Promise<void> {
    await mkdir(path.join(home, 'credentials'), { recursive: true })
    await writeFile(
      path.join(home, 'credentials', file),
      JSON.stringify({
        access_token: SECRET,
        refresh_token: 'refresh-secret',
        expires_at: expiresAt,
      }),
    )
  }

  function answer(body: unknown, status = 200) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }))
  }

  it('sends the token only to Kimi Code usage endpoint and returns none of it', async () => {
    await token('kimi-code.json', NOW / 1000 + 600)
    const fetch = answer({ ...MANAGED, echo: SECRET })
    const usage = await readKimiCodeUsage({
      env: { KIMI_CODE_HOME: home },
      home: '/unused',
      platform: 'linux',
      now: NOW,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.kimi.com/coding/v1/usages')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.stringify(usage)).not.toContain(SECRET)
  })

  it('reads the global region token from api.kimi.ai', async () => {
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          oauthHost: 'https://auth.kimi.ai',
          baseUrl: 'https://api.kimi.ai/coding/v1',
        }),
      )
      .digest('hex')
      .slice(0, 16)
    await token(`kimi-code-env-${digest}.json`, 0)
    const fetch = answer(MANAGED)
    await readKimiCodeUsage({
      env: { KIMI_CODE_HOME: home },
      home: '/unused',
      platform: 'linux',
      now: NOW,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://api.kimi.ai/coding/v1/usages',
    )
  })

  it('fails without sending anything when the sign-in is missing or expired', async () => {
    const fetch = answer(MANAGED)
    const read = () =>
      readKimiCodeUsage({
        env: { KIMI_CODE_HOME: home },
        home: '/unused',
        platform: 'linux',
        now: NOW,
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
    await expect(read()).rejects.toThrow('Kimi Code is not signed in')
    await token('kimi-code.json', NOW / 1000 - 60)
    await expect(read()).rejects.toThrow('sign-in has expired')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails on a refused token without quoting the answer', async () => {
    await token('kimi-code.json', 0)
    const error = await readKimiCodeUsage({
      env: { KIMI_CODE_HOME: home },
      home: '/unused',
      platform: 'linux',
      now: NOW,
      fetch: answer({ error: `invalid ${SECRET}` }, 401) as unknown as typeof globalThis.fetch,
    }).catch((caught: unknown) => caught)
    expect((error as Error).message).toBe('Kimi Code did not accept the stored sign-in')
  })
})
