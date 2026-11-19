import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseCodexResetCount,
  parseCodexResetCredits,
  readCodexResets,
  spendCodexReset,
  type CodexPlace,
} from './codex'
import { UsageReadError } from './stored-sign-in'

const TOKEN = 'access-token-secret-123'
const ACCOUNT = 'a27c48c3-0000-4000-8000-000000000000'
const REQUEST = '0b0e7a52-6d0c-4a6e-9a3b-0d6f6f0c2a11'
const NOW = 1_795_000_000_000

const folders: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true })))
})

function idToken(account: unknown): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: account } }
  return `${part({ alg: 'none' })}.${part(claims)}.signature`
}

async function folderWith(auth: unknown): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'codex-resets-'))
  folders.push(folder)
  if (auth !== undefined) await writeFile(path.join(folder, 'auth.json'), JSON.stringify(auth))
  return folder
}

const signedIn = () =>
  folderWith({
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken(ACCOUNT), access_token: TOKEN, refresh_token: 'refresh-secret' },
  })

type Answer = { status?: number; body: unknown } | 'hang' | 'down'

/** A vendor that answers by path, and what it was asked. */
function vendor(answers: Record<string, Answer>) {
  const asked: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    asked.push({ url, init })
    const answer = answers[new URL(url).pathname]
    if (answer === undefined || answer === 'down') throw new TypeError('fetch failed')
    if (answer === 'hang') {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, asked }
}

function place(folder: string, fetch: typeof globalThis.fetch): CodexPlace {
  return {
    env: {},
    home: '/nowhere',
    platform: 'linux',
    now: NOW,
    fetch,
    folder,
    version: '0.170.0',
  }
}

const USAGE = '/backend-api/wham/usage'
const CREDITS = '/backend-api/wham/rate-limit-reset-credits'
const CONSUME = '/backend-api/wham/rate-limit-reset-credits/consume'

const usage = (available: number, applicable = 0) => ({
  plan_type: 'plus',
  rate_limit_reset_credits: {
    available_count: available,
    applicable_available_count: applicable,
  },
})

const credit = (id: string, expires: string | null, status = 'available') => ({
  id,
  reset_type: 'codex_rate_limits',
  status,
  expires_at: expires,
  title: 'Full reset',
})

describe('parseCodexResetCount', () => {
  it('takes the available count, never the applicable one', () => {
    expect(parseCodexResetCount(usage(1, 0))).toBe(1)
    expect(parseCodexResetCount(usage(0, 3))).toBe(0)
  })

  it('reads nothing from a reply without a whole count', () => {
    for (const reply of [null, {}, { rate_limit_reset_credits: null }, usage(-1), usage(1.5)]) {
      expect(parseCodexResetCount(reply)).toBeNull()
    }
  })
})

describe('parseCodexResetCredits', () => {
  it('orders the available credits by expiry, those that never expire last', () => {
    const reply = {
      credits: [
        credit('never', null),
        credit('later', '2026-12-20T00:00:00Z'),
        credit('spent', '2026-11-20T00:00:00Z', 'redeemed'),
        credit('sooner', '2026-12-12T22:05:48.692682Z'),
        credit('never-too', null),
      ],
    }
    expect(parseCodexResetCredits(reply, 4)).toEqual([
      { id: 'sooner', until: Date.parse('2026-12-12T22:05:48.692Z') },
      { id: 'later', until: Date.parse('2026-12-20T00:00:00Z') },
      { id: 'never', until: null },
      { id: 'never-too', until: null },
    ])
  })

  it('drops a list that disagrees with the count', () => {
    const reply = { credits: [credit('a', null), credit('b', null, 'redeeming')] }
    expect(parseCodexResetCredits(reply, 2)).toBeNull()
    expect(parseCodexResetCredits(reply, 1)).toEqual([{ id: 'a', until: null }])
  })

  it('drops a list it cannot read rather than guess an expiry', () => {
    expect(parseCodexResetCredits({}, 1)).toBeNull()
    expect(parseCodexResetCredits({ credits: [credit('a', 'soon')] }, 1)).toBeNull()
    expect(parseCodexResetCredits({ credits: [{ status: 'available' }] }, 1)).toBeNull()
  })
})

describe('readCodexResets', () => {
  it('asks as the CLI does, only the listed endpoint, and keeps the token out of the result', async () => {
    const { fetch, asked } = vendor({
      [USAGE]: { body: usage(1) },
      [CREDITS]: { body: { credits: [credit('c1', '2026-12-12T22:05:48Z')] } },
    })
    const read = await readCodexResets(place(await signedIn(), fetch))
    expect(read).toEqual({
      resets: {
        count: 1,
        each: [{ id: 'c1', until: Date.parse('2026-12-12T22:05:48Z') }],
        observedAt: NOW,
      },
      details: 'read',
    })
    expect(asked.map((ask) => ask.url)).toEqual([
      `https://chatgpt.com${USAGE}`,
      `https://chatgpt.com${CREDITS}`,
    ])
    for (const { init } of asked) {
      expect(init.method).toBe('GET')
      expect(init.redirect).toBe('error')
      expect(init.headers).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
        'chatgpt-account-id': ACCOUNT,
        originator: 'codex_cli_rs',
        'user-agent': 'codex_cli_rs/0.170.0',
      })
    }
    expect(JSON.stringify(read)).not.toContain(TOKEN)
  })

  it('does not ask for the details of no credits', async () => {
    const { fetch, asked } = vendor({ [USAGE]: { body: usage(0, 2) } })
    const read = await readCodexResets(place(await signedIn(), fetch))
    expect(read?.resets).toEqual({ count: 0, each: [], observedAt: NOW })
    expect(asked).toHaveLength(1)
  })

  it('keeps the count with unknown expiries when the details fail', async () => {
    for (const details of [
      'down',
      { status: 500, body: {} },
      { body: { credits: [] } },
    ] satisfies Answer[]) {
      const { fetch } = vendor({ [USAGE]: { body: usage(2) }, [CREDITS]: details })
      const read = await readCodexResets(place(await signedIn(), fetch))
      expect(read).toEqual({ resets: { count: 2, observedAt: NOW }, details: 'failed' })
    }
  })

  it('gives up on the details after 4 seconds', async () => {
    const { fetch, asked } = vendor({ [USAGE]: { body: usage(1) }, [CREDITS]: 'hang' })
    const folder = await signedIn()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let read: unknown = null
    void readCodexResets(place(folder, fetch)).then((value) => (read = value))
    while (asked.length < 2) await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(3_999)
    expect(read).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(read).toEqual({ resets: { count: 1, observedAt: NOW }, details: 'failed' })
  })

  it('tells an expired sign-in by its 401, from either endpoint, without the token', async () => {
    const refused = { status: 401, body: { error: `bad token ${TOKEN}` } }
    const first = vendor({ [USAGE]: refused })
    const error = await readCodexResets(place(await signedIn(), first.fetch)).catch((e) => e)
    expect(error).toBeInstanceOf(UsageReadError)
    expect((error as UsageReadError).status).toBe(401)
    expect(String(error)).not.toContain(TOKEN)

    const second = vendor({ [USAGE]: { body: usage(1) }, [CREDITS]: refused })
    expect(await readCodexResets(place(await signedIn(), second.fetch))).toEqual({
      resets: { count: 1, observedAt: NOW },
      details: 'sign-in-expired',
    })
  })

  it('asks nothing without a ChatGPT sign-in', async () => {
    const { fetch, asked } = vendor({})
    for (const auth of [
      undefined,
      { OPENAI_API_KEY: 'sk-key', tokens: null },
      { tokens: { access_token: TOKEN, id_token: 'not-a-jwt' } },
      { tokens: { access_token: '', id_token: idToken(ACCOUNT) } },
      { tokens: { access_token: TOKEN, id_token: idToken(null) } },
    ]) {
      expect(await readCodexResets(place(await folderWith(auth), fetch))).toBeNull()
    }
    expect(asked).toHaveLength(0)
  })
})

describe('spendCodexReset', () => {
  it('posts the credit and the idempotency key it was given, unchanged on a retry', async () => {
    const { fetch, asked } = vendor({ [CONSUME]: { body: { code: 'reset', windows_reset: 2 } } })
    const folder = await signedIn()
    expect(await spendCodexReset(place(folder, fetch), 'c1', REQUEST)).toBe('reset')
    expect(await spendCodexReset(place(folder, fetch), 'c1', REQUEST)).toBe('reset')
    expect(asked).toHaveLength(2)
    for (const { url, init } of asked) {
      expect(url).toBe(`https://chatgpt.com${CONSUME}`)
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body as string)).toEqual({
        credit_id: 'c1',
        redeem_request_id: REQUEST,
      })
      expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    }
  })

  it('returns each answer the vendor gives and refuses one it does not know', async () => {
    const folder = await signedIn()
    for (const code of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']) {
      const { fetch } = vendor({ [CONSUME]: { body: { code } } })
      expect(await spendCodexReset(place(folder, fetch), 'c1', REQUEST)).toBe(code)
    }
    for (const body of [{ code: 'maybe' }, {}, null]) {
      const { fetch } = vendor({ [CONSUME]: { body } })
      await expect(spendCodexReset(place(folder, fetch), 'c1', REQUEST)).rejects.toThrow(
        UsageReadError,
      )
    }
  })

  it('fails without spending when signed out, and tells a refused sign-in', async () => {
    const none = vendor({})
    await expect(
      spendCodexReset(place(await folderWith(undefined), none.fetch), 'c1', REQUEST),
    ).rejects.toThrow(UsageReadError)
    expect(none.asked).toHaveLength(0)
    const refused = vendor({ [CONSUME]: { status: 401, body: {} } })
    const error = await spendCodexReset(
      place(await signedIn(), refused.fetch),
      'c1',
      REQUEST,
    ).catch((e) => e)
    expect((error as UsageReadError).status).toBe(401)
  })
})
