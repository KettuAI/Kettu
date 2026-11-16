import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDevinStatus, readDevinUsage } from './devin'

const SECRET = 'devin-session-token$secret-123'
const NOW = 1_763_000_000_000

// The shape of a `GetUserStatus` reply on a quota plan, its zeros left out as Connect JSON does.
const STATUS = {
  userStatus: {
    email: 'someone@example.com',
    planStatus: {
      planInfo: { planName: 'Pro', billingStrategy: 'BILLING_STRATEGY_QUOTA' },
      dailyQuotaRemainingPercent: 75,
      dailyQuotaResetAtUnix: '1763020000',
      weeklyQuotaResetAtUnix: '1763500000',
      overageBalanceMicros: '3500000',
    },
  },
}

describe('Devin GetUserStatus reply', () => {
  it('maps the daily and weekly quotas and the overage balance', () => {
    const usage = parseDevinStatus(STATUS, NOW)!
    expect(usage.tier).toBe('Pro')
    expect(usage.limits.map((l) => [l.window, l.usedPercent, l.resetsAt])).toEqual([
      ['1_day', 25, 1_763_020_000_000],
      // A quota plan's window with a reset and no share left is used up.
      ['seven_day', 100, 1_763_500_000_000],
    ])
    expect(usage.balances).toEqual([{ label: 'Extra usage', amount: 3.5, currency: 'USD' }])
  })

  it('leaves out a quota the plan hides', () => {
    const usage = parseDevinStatus(
      {
        userStatus: {
          planStatus: {
            planInfo: { hideDailyQuota: true },
            dailyQuotaRemainingPercent: 10,
            weeklyQuotaRemainingPercent: 60,
          },
        },
      },
      NOW,
    )!
    expect(usage.limits.map((l) => l.window)).toEqual(['seven_day'])
  })
})

describe('reading with Devin stored sign-in', () => {
  let data: string
  beforeEach(async () => {
    data = await mkdtemp(path.join(os.tmpdir(), 'kettu-devin-'))
    await mkdir(path.join(data, 'devin'))
  })
  afterEach(async () => {
    await rm(data, { recursive: true, force: true })
  })

  const read = (fetch: ReturnType<typeof vi.fn>) =>
    readDevinUsage({
      env: { XDG_DATA_HOME: data },
      home: '/unused',
      platform: 'linux',
      now: NOW,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })

  const credentials = (server: string) =>
    writeFile(
      path.join(data, 'devin', 'credentials.toml'),
      `windsurf_api_key = "${SECRET}"\napi_server_url = "${server}"\n`,
    )

  it('sends the key only to Devin server and returns none of it', async () => {
    await credentials('https://server.codeium.com')
    const fetch = vi.fn(async () => new Response(JSON.stringify(STATUS)))
    const usage = await read(fetch)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
    )
    expect(JSON.parse(init.body as string).metadata.apiKey).toBe(SECRET)
    expect(JSON.stringify(usage)).not.toContain(SECRET)
  })

  it('never sends a sign-in to a server that is not listed', async () => {
    await credentials('https://devin.example.internal')
    const fetch = vi.fn()
    await expect(read(fetch)).rejects.toThrow('does not read')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails without sending anything when it is not signed in', async () => {
    const fetch = vi.fn()
    await expect(read(fetch)).rejects.toThrow('Devin is not signed in')
    expect(fetch).not.toHaveBeenCalled()
  })
})
