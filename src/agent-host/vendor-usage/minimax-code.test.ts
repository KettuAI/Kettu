import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseMiniMaxRemains, readMiniMaxCodeUsage } from './minimax-code'
import { UsageReadError } from './stored-sign-in'

const SECRET = 'minimax-secret-123'
const NOW = 1_763_000_000_000

// The shape of a `/v1/token_plan/remains` reply, which `coding_plan/remains` shares.
const REMAINS = {
  model_remains: [
    {
      model_name: 'general',
      start_time: 1_762_990_000_000,
      end_time: 1_763_008_000_000,
      current_interval_remaining_percent: 70,
      current_interval_status: 1,
      weekly_start_time: 1_762_500_000_000,
      weekly_end_time: 1_763_104_800_000,
      current_weekly_remaining_percent: 90,
      current_weekly_status: 1,
    },
    { model_name: 'video', current_interval_remaining_percent: 100 },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
}

describe('MiniMax remains reply', () => {
  it('maps the general pool to the 5-hour and weekly windows', () => {
    const usage = parseMiniMaxRemains(REMAINS, NOW)!
    expect(usage.limits.map((l) => [l.window, l.usedPercent, l.resetsAt])).toEqual([
      ['five_hour', 30, 1_763_008_000_000],
      ['weekly', 10, 1_763_104_800_000],
    ])
  })

  it('reads a refusal, given with status 200, as no usage', () => {
    expect(
      parseMiniMaxRemains({ base_resp: { status_code: 1004, status_msg: 'invalid key' } }, NOW),
    ).toBeNull()
  })
})

describe('reading with MiniMax Code stored sign-in', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-minimax-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const read = (fetch: ReturnType<typeof vi.fn>, env: Record<string, string> = {}) =>
    readMiniMaxCodeUsage({
      env: { MINIMAX_DATA_DIR: dir, ...env },
      home: '/unused',
      platform: 'linux',
      now: NOW,
      fetch: fetch as unknown as typeof globalThis.fetch,
    })

  const answer = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body)))

  it('sends an API key to the documented endpoint of its region', async () => {
    await writeFile(
      path.join(dir, 'config.yaml'),
      `minimax_api:\n  apiKey: ${SECRET}\n  baseURL: https://api.minimax.io/v1\n`,
    )
    const fetch = answer({ ...REMAINS, echo: SECRET })
    const usage = await read(fetch)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.minimax.io/v1/token_plan/remains')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.stringify(usage)).not.toContain(SECRET)
  })

  const signIn = async (region: 'cn' | 'en') => {
    const auth = path.join(dir, 'cli-auth', 'prod', region)
    await mkdir(auth, { recursive: true })
    await writeFile(
      path.join(auth, 'local-runtime.auth.json'),
      JSON.stringify({ version: 1, auth: { accessToken: SECRET } }),
    )
  }

  it('signs the account request as MiniMax Code 0.7 does', async () => {
    await signIn('cn')
    const fetch = answer(REMAINS)
    await read(fetch)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains?business=Agent&device_platform=mcode',
    )
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(headers.token).toBeUndefined()
  })

  it('asks the international endpoint for an account of that region', async () => {
    await signIn('en')
    const fetch = answer(REMAINS)
    await read(fetch, { MAVIS_REGION: 'en' })
    const [url] = fetch.mock.calls[0] as unknown as [string]
    expect(new URL(url).origin).toBe('https://platform.minimax.io')
  })

  it('reads the windows from a reply shaped as MiniMax Code 0.7 reads it', async () => {
    await signIn('cn')
    // 0.7 takes the first pool for the 5-hour and weekly windows, and meters video apart.
    const reply = {
      model_remains: [
        {
          model_name: 'MiniMax-M2',
          current_interval_status: 1,
          current_interval_remaining_percent: 64,
          end_time: 1_763_008_000_000,
          current_weekly_status: 1,
          current_weekly_remaining_percent: 85,
          weekly_end_time: 1_763_104_800_000,
        },
        {
          model_name: 'video',
          current_interval_total_count: 10,
          current_interval_usage_count: 4,
          end_time: 1_763_008_000_000,
        },
      ],
      base_resp: { status_code: 0, status_msg: 'success' },
    }
    const usage = await read(answer(reply))
    expect(usage.limits.map((l) => [l.window, l.usedPercent, l.resetsAt])).toEqual([
      ['five_hour', 36, 1_763_008_000_000],
      ['weekly', 15, 1_763_104_800_000],
    ])
  })

  it('never puts the account token into an error', async () => {
    await signIn('cn')
    const replies = [
      new Response(JSON.stringify({ error: `bad token ${SECRET}` }), { status: 401 }),
      new Response(`upstream failed for ${SECRET}`, { status: 500 }),
      new Response(`not json ${SECRET}`),
      new Response(JSON.stringify({ base_resp: { status_code: 1004, status_msg: SECRET } })),
    ]
    for (const reply of replies) {
      const error = await read(vi.fn(async () => reply)).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(UsageReadError)
      expect(String(error)).not.toContain(SECRET)
      expect(JSON.stringify(error)).not.toContain(SECRET)
    }
  })

  it('fails without sending anything when it is not signed in', async () => {
    const fetch = answer(REMAINS)
    await expect(read(fetch)).rejects.toThrow('MiniMax Code is not signed in')
    expect(fetch).not.toHaveBeenCalled()
  })
})
