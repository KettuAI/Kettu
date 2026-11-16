import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClineBalance, parseClinePlan, readClineUsage } from './cline'

const SECRET = 'cline-access-secret-123'
const NOW = Date.parse('2026-11-15T00:00:00Z')

describe('Cline account replies', () => {
  it('reads the balance in millionths of a dollar', () => {
    expect(parseClineBalance({ success: true, data: { balance: 4_250_000, userId: 'u1' } })).toBe(
      4.25,
    )
  })

  it('reads the plan name and when its period renews', () => {
    const plan = parseClinePlan(
      {
        success: true,
        data: {
          currentPeriodStart: '2026-11-01T00:00:00Z',
          currentPeriodEnd: '2026-12-01T00:00:00Z',
          plan: { displayName: 'ClinePass', interval: 'month' },
        },
      },
      NOW,
    )
    expect(plan.tier).toBe('ClinePass')
    expect(plan.period).toMatchObject({
      window: 'monthly',
      usedPercent: null,
      resetsAt: Date.parse('2026-12-01T00:00:00Z'),
    })
  })

  it('takes a refused reply as a failure', () => {
    expect(() => parseClineBalance({ success: false, error: 'no' })).toThrow('refused')
  })
})

describe('reading with Cline stored sign-in', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-cline-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function signIn(auth: Record<string, unknown>): Promise<void> {
    await mkdir(path.join(dir, 'data', 'settings'), { recursive: true })
    await writeFile(
      path.join(dir, 'data', 'settings', 'providers.json'),
      JSON.stringify({
        version: 1,
        providers: { cline: { settings: { provider: 'cline', auth } } },
      }),
    )
  }

  const read = (fetch: ReturnType<typeof vi.fn>) =>
    readClineUsage({
      env: { CLINE_DIR: dir },
      home: '/unused',
      platform: 'linux',
      now: NOW,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })

  function api(plan: { status: number; body: unknown }) {
    return vi.fn(async (url: string) => {
      if (url.endsWith('/users/me')) {
        return new Response(JSON.stringify({ success: true, data: { id: 'u1', echo: SECRET } }))
      }
      if (url.endsWith('/users/u1/balance')) {
        return new Response(JSON.stringify({ success: true, data: { balance: 2_000_000 } }))
      }
      return new Response(JSON.stringify(plan.body), { status: plan.status })
    })
  }

  it('sends the token only to Cline account endpoints and returns none of it', async () => {
    await signIn({ accessToken: `workos:${SECRET}`, expiresAt: NOW + 60_000 })
    const fetch = api({
      status: 200,
      body: { success: true, data: { currentPeriodEnd: '2026-12-01T00:00:00Z', plan: {} } },
    })
    const usage = await read(fetch)
    const calls = fetch.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url]) => url).sort()).toEqual([
      'https://api.cline.bot/api/v1/users/me',
      'https://api.cline.bot/api/v1/users/me/plan',
      'https://api.cline.bot/api/v1/users/u1/balance',
    ])
    for (const [, init] of calls) {
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer workos:${SECRET}`)
    }
    expect(usage.balances).toEqual([{ label: 'Prepaid balance', amount: 2, currency: 'USD' }])
    expect(JSON.stringify(usage)).not.toContain(SECRET)
  })

  it('keeps the balance of an account without a plan', async () => {
    await signIn({ accessToken: SECRET })
    const usage = await read(api({ status: 404, body: { success: false, error: 'none' } }))
    expect(usage.limits).toEqual([])
    expect(usage.balances).toHaveLength(1)
  })

  it('fails without sending anything when the sign-in is missing or expired', async () => {
    const fetch = api({ status: 200, body: {} })
    await expect(read(fetch)).rejects.toThrow('Cline is not signed in')
    await signIn({ accessToken: SECRET, expiresAt: NOW - 1 })
    await expect(read(fetch)).rejects.toThrow('sign-in has expired')
    expect(fetch).not.toHaveBeenCalled()
  })
})
