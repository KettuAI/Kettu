import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import about from './fixtures/cursor-about.json'
import aboutSignedOut from './fixtures/cursor-about-signed-out.json'
import planInfo from './fixtures/cursor-plan-info.json'
import periodUsage from './fixtures/cursor-current-period-usage.json'
import {
  forgetKeychainRefusal,
  KEYCHAIN_BACKOFF_MS,
  KeychainRefused,
  parseCursorAbout,
  parseCursorUsage,
  readCursorUsage,
  type CursorPlace,
  type KeychainRead,
} from './cursor'

const SECRET = 'cursor-access-secret-123'
const NOW = Date.parse('2026-11-17T15:30:00Z')
const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
const PLAN_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo'

// A signed-out CLI's answer to `about --format json` (2026.10.22).
const SIGNED_OUT =
  "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable."

function dashboard(status = 200): typeof globalThis.fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const body = String(url) === PLAN_URL ? planInfo : periodUsage
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof globalThis.fetch
}

describe('Cursor about reply', () => {
  it('reads a recorded signed-in reply as the account and its plan', () => {
    const run = { code: 0, stdout: JSON.stringify(about), stderr: '' }
    expect(parseCursorAbout(run)).toEqual({
      state: 'authenticated',
      account: { kind: 'account', label: 'Free', email: 'user@example.com' },
    })
  })

  it('reads a recorded signed-out reply of a file sign-in store as signed out', () => {
    const run = { code: 0, stdout: JSON.stringify(aboutSignedOut), stderr: '' }
    expect(parseCursorAbout(run)).toEqual({ state: 'unauthenticated', account: null })
  })

  it('reads the recorded signed-out error as signed out', () => {
    expect(parseCursorAbout({ code: 1, stdout: '', stderr: SIGNED_OUT })).toEqual({
      state: 'unauthenticated',
      account: null,
    })
  })

  it('refuses an answer it cannot read instead of calling it signed out', () => {
    expect(parseCursorAbout({ code: 1, stdout: '', stderr: 'spawn failed' })).toBeNull()
    expect(parseCursorAbout({ code: 0, stdout: 'not json', stderr: '' })).toBeNull()
    expect(parseCursorAbout({ code: 0, stdout: '{"cliVersion":"x"}', stderr: '' })).toBeNull()
  })
})

describe('Cursor usage reply', () => {
  it('maps a recorded merged plan to one weekly window and its plan name', () => {
    const usage = parseCursorUsage(periodUsage, planInfo, NOW)
    expect(usage?.tier).toBe('Free')
    expect(usage?.limits).toEqual([
      {
        window: 'seven_day',
        label: 'Weekly',
        usedPercent: 0,
        resetsAt: 1795523203231,
        state: 'ok',
        observedAt: NOW,
      },
    ])
  })

  it('shows the Auto and other-model pools of a plan that is not merged', () => {
    const usage = parseCursorUsage(
      {
        ...periodUsage,
        planUsage: { totalPercentUsed: 40, autoPercentUsed: 25, apiPercentUsed: 60 },
      },
      { planInfo: { ...planInfo.planInfo, includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_MONTHLY' } },
      NOW,
    )
    expect(usage?.limits.map((l) => [l.window, l.usedPercent])).toEqual([
      ['monthly', 40],
      ['auto', 25],
      ['other_models', 60],
    ])
  })

  it('refuses a reply without its pools', () => {
    expect(parseCursorUsage({ billingCycleEnd: '1' }, planInfo, NOW)).toBeNull()
    expect(parseCursorUsage({ planUsage: { totalPercentUsed: 'all' } }, planInfo, NOW)).toBeNull()
  })
})

describe('readCursorUsage', () => {
  let home: string

  beforeEach(async () => {
    forgetKeychainRefusal()
    home = await mkdtemp(path.join(os.tmpdir(), 'kettu-cursor-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  function place(over: Partial<CursorPlace>): CursorPlace {
    return { env: {}, home, platform: 'darwin', now: NOW, fetch: dashboard(), ...over }
  }

  async function writeAuthFile(file: string, token: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ accessToken: token, refreshToken: 'refresh-secret' }))
  }

  it('sends the keychain token only to the Dashboard service, without redirects', async () => {
    const keychain = vi.fn<KeychainRead>(async () => ({ secret: SECRET }))
    const fetch = dashboard()
    const usage = await readCursorUsage(place({ keychain, fetch }))
    expect(usage.tier).toBe('Free')
    expect(keychain).toHaveBeenCalledWith('cursor-access-token', 'cursor-user')
    const calls = vi.mocked(fetch).mock.calls
    expect(calls.map(([url]) => String(url)).sort()).toEqual([PLAN_URL, USAGE_URL].sort())
    for (const [, init] of calls) {
      expect(init?.redirect).toBe('error')
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
    }
  })

  it('does not ask the keychain again within the backoff after a refusal', async () => {
    const keychain = vi.fn<KeychainRead>(async () => ({ refused: true }))
    await expect(readCursorUsage(place({ keychain }))).rejects.toBeInstanceOf(KeychainRefused)
    await expect(
      readCursorUsage(place({ keychain, now: NOW + KEYCHAIN_BACKOFF_MS - 1 })),
    ).rejects.toBeInstanceOf(KeychainRefused)
    expect(keychain).toHaveBeenCalledTimes(1)
    keychain.mockImplementation(async () => ({ secret: SECRET }))
    await readCursorUsage(place({ keychain, now: NOW + KEYCHAIN_BACKOFF_MS }))
    expect(keychain).toHaveBeenCalledTimes(2)
  })

  it('reads the auth file when the keychain has no item, and skips the keychain for a file store', async () => {
    await writeAuthFile(path.join(home, '.cursor', 'auth.json'), SECRET)
    const missing = vi.fn<KeychainRead>(async () => ({ missing: true }))
    await expect(readCursorUsage(place({ keychain: missing }))).resolves.toMatchObject({
      tier: 'Free',
    })
    const unused = vi.fn<KeychainRead>(async () => ({ secret: 'other' }))
    const fetch = dashboard()
    await readCursorUsage(
      place({ keychain: unused, fetch, env: { AGENT_CLI_CREDENTIAL_STORE: 'file' } }),
    )
    expect(unused).not.toHaveBeenCalled()
    const init = vi.mocked(fetch).mock.calls[0]![1]
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
  })

  it('reads the Linux auth file under XDG_CONFIG_HOME and never the keychain there', async () => {
    const config = path.join(home, 'config')
    await writeAuthFile(path.join(config, 'cursor', 'auth.json'), SECRET)
    const keychain = vi.fn<KeychainRead>(async () => ({ secret: 'other' }))
    await readCursorUsage(place({ platform: 'linux', keychain, env: { XDG_CONFIG_HOME: config } }))
    expect(keychain).not.toHaveBeenCalled()
  })

  it('has the CLI renew a refused token once, then reads with the new one', async () => {
    let token = 'expired-token'
    const keychain = vi.fn<KeychainRead>(async () => ({ secret: token }))
    const renew = vi.fn(async () => {
      token = SECRET
    })
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization
      if (auth !== `Bearer ${SECRET}`) return new Response('{}', { status: 401 })
      return new Response(JSON.stringify(String(url) === PLAN_URL ? planInfo : periodUsage))
    }) as unknown as typeof globalThis.fetch
    await expect(readCursorUsage(place({ keychain, renew, fetch }))).resolves.toMatchObject({
      tier: 'Free',
    })
    expect(renew).toHaveBeenCalledTimes(1)
  })

  it('says an API key sign-in has no usage read instead of calling it signed out', async () => {
    const keychain = vi.fn<KeychainRead>(async () => ({ missing: true }))
    const fetch = dashboard()
    await expect(
      readCursorUsage(place({ keychain, fetch, env: { CURSOR_API_KEY: SECRET } })),
    ).rejects.toThrow('API key')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('says it is signed out without a token, and never quotes one in its errors', async () => {
    const keychain = vi.fn<KeychainRead>(async () => ({ missing: true }))
    await expect(readCursorUsage(place({ keychain }))).rejects.toThrow('Cursor is not signed in')
    const echoed = vi.fn(
      async () => new Response(`{"error":"bad ${SECRET}"}`, { status: 500 }),
    ) as unknown as typeof globalThis.fetch
    const error = await readCursorUsage(
      place({ keychain: async () => ({ secret: SECRET }), fetch: echoed }),
    ).catch((e: unknown) => e as Error)
    expect(String(error)).not.toContain(SECRET)
  })
})
