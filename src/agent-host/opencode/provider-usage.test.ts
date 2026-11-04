import { describe, expect, it, vi } from 'vitest'
import {
  failedUsage,
  mapNativeUsage,
  readProviderUsage,
  unsupportedUsage,
  USAGE_ERROR,
} from './provider-usage'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fetchOnce(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => json(body, status)) as unknown as typeof fetch
}

describe('readProviderUsage', () => {
  it('leaves a provider without a known endpoint unsupported and sends nothing', async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch
    expect(await readProviderUsage({ providerId: 'mystery', key: 'k', now: 7, fetch })).toEqual(
      unsupportedUsage(7),
    )
    expect(await readProviderUsage({ providerId: 'constructor', key: 'k', now: 7, fetch })).toEqual(
      unsupportedUsage(7),
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('treats an empty balance or allowance as an error from a supported provider', async () => {
    expect(
      await readProviderUsage({
        providerId: 'deepseek',
        key: 'k',
        now: 11,
        fetch: fetchOnce({ balance_infos: [] }),
      }),
    ).toEqual(failedUsage(11))
    expect(
      await readProviderUsage({
        providerId: 'opencode-go',
        key: 'k',
        now: 11,
        fetch: fetchOnce({ usage: {} }),
      }),
    ).toEqual(failedUsage(11))
  })

  it('reads DeepSeek balances from an environment key', async () => {
    const fetch = vi.fn(async () =>
      json({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '12.50' },
          { currency: 'USD', total_balance: 3 },
        ],
      }),
    ) as unknown as typeof globalThis.fetch
    expect(
      await readProviderUsage({ providerId: 'deepseek', key: 'sk-deep', now: 9, fetch }),
    ).toEqual({
      state: 'ready',
      limits: [],
      balances: [
        { label: 'Balance', amount: 12.5, currency: 'CNY' },
        { label: 'Balance', amount: 3, currency: 'USD' },
      ],
      observedAt: 9,
      error: null,
    })
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('https://api.deepseek.com/user/balance')
    expect(init.redirect).toBe('error')
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk-deep' })
    expect(init.signal).toBeDefined()
  })

  it('reads Moonshot balances in the currency of each host', async () => {
    const global = await readProviderUsage({
      providerId: 'moonshotai',
      key: 'k',
      now: 1,
      fetch: fetchOnce({ code: 0, data: { available_balance: 8.25 } }),
    })
    expect(global.balances).toEqual([{ label: 'Balance', amount: 8.25, currency: 'USD' }])
    const cn = await readProviderUsage({
      providerId: 'moonshotai-cn',
      key: 'k',
      now: 1,
      fetch: fetchOnce({ code: 0, data: { available_balance: 30 } }),
    })
    expect(cn.balances).toEqual([{ label: 'Balance', amount: 30, currency: 'CNY' }])
  })

  it('reads the OpenRouter credit balance', async () => {
    const usage = await readProviderUsage({
      providerId: 'openrouter',
      key: 'k',
      now: 2,
      fetch: fetchOnce({ data: { total_credits: 10, total_usage: 2.5 } }),
    })
    expect(usage.balances).toEqual([{ label: 'Balance', amount: 7.5, currency: 'USD' }])
  })

  it('maps the OpenCode Go windows', async () => {
    const usage = await readProviderUsage({
      providerId: 'opencode-go',
      key: 'k',
      now: 3,
      fetch: fetchOnce({
        usage: {
          rolling: { status: 'ok', percent: 25, resetsAt: '2026-11-03T12:00:00Z' },
          weekly: { status: 'ok', percent: 12.5, resetsAt: '2026-11-10T00:00:00Z' },
          monthly: { status: 'limited', percent: 100, resetsAt: 1_800_000_000 },
        },
      }),
    })
    expect(usage.state).toBe('ready')
    expect(usage.limits).toEqual([
      {
        window: 'rolling',
        label: 'Rolling',
        usedPercent: 25,
        resetsAt: Date.parse('2026-11-03T12:00:00Z'),
        state: 'ok',
        observedAt: 3,
      },
      {
        window: 'weekly',
        label: 'Weekly',
        usedPercent: 12.5,
        resetsAt: Date.parse('2026-11-10T00:00:00Z'),
        state: 'ok',
        observedAt: 3,
      },
      {
        window: 'monthly',
        label: 'Monthly',
        usedPercent: 100,
        resetsAt: 1_800_000_000_000,
        state: 'reached',
        observedAt: 3,
      },
    ])
  })

  it('sends the Z.ai and GLM key without a Bearer prefix', async () => {
    const fetch = vi.fn(async () =>
      json({
        code: 200,
        success: true,
        data: {
          limits: [
            {
              type: 'TOKENS_LIMIT',
              unit: 3,
              number: 5,
              percentage: 40,
              nextResetTime: 1_800_000_000_000,
            },
            {
              type: 'TOKENS_LIMIT',
              unit: 6,
              number: 1,
              percentage: 88,
              nextResetTime: '2026-11-04T00:00:00Z',
            },
            { type: 'TIME_LIMIT', unit: 5, percentage: 10, nextResetTime: null },
          ],
        },
      }),
    ) as unknown as typeof globalThis.fetch
    const usage = await readProviderUsage({ providerId: 'zai', key: 'sk-glm', now: 4, fetch })
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(init.headers).toMatchObject({ authorization: 'sk-glm' })
    expect(usage.limits.map((limit) => [limit.window, limit.label, limit.usedPercent])).toEqual([
      ['five_hour', '5-hour', 40],
      ['seven_day', 'Weekly', 88],
      ['tool_calls', 'Tool calls', 10],
    ])
    expect(usage.limits[1]?.resetsAt).toBe(Date.parse('2026-11-04T00:00:00Z'))
  })

  it('maps the Kimi coding windows', async () => {
    const usage = await readProviderUsage({
      providerId: 'kimi-code-plan-global',
      key: 'k',
      now: 5,
      fetch: fetchOnce({
        usage: { limit: '100', remaining: '25', resetTime: '2026-11-10T00:00:00Z' },
        limits: [
          {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: {
              limit: '100',
              used: '40',
              remaining: '60',
              resetTime: '2026-11-03T10:00:00Z',
            },
          },
        ],
      }),
    })
    expect(usage.limits.map((limit) => [limit.window, limit.label, limit.usedPercent])).toEqual([
      ['five_hour', '5-hour', 40],
      ['seven_day', 'Weekly', 75],
    ])
  })

  it('uses each Kimi region host', async () => {
    const globalFetch = vi.fn(async () =>
      json({ usage: { limit: '1', remaining: '1', resetTime: '2026-11-10T00:00:00Z' } }),
    ) as unknown as typeof globalThis.fetch
    await readProviderUsage({
      providerId: 'kimi-code-plan-global',
      key: 'k',
      now: 5,
      fetch: globalFetch,
    })
    expect((globalFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://api.kimi.ai/coding/v1/usages',
    )
    const cnFetch = vi.fn(async () =>
      json({ usage: { limit: '1', remaining: '1', resetTime: '2026-11-10T00:00:00Z' } }),
    ) as unknown as typeof globalThis.fetch
    await readProviderUsage({
      providerId: 'kimi-code-plan-cn',
      key: 'k',
      now: 5,
      fetch: cnFetch,
    })
    expect((cnFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      'https://api.kimi.com/coding/v1/usages',
    )
  })

  it('maps MiniMax token plan percentages and fails on a business error', async () => {
    const usage = await readProviderUsage({
      providerId: 'minimax-coding-plan',
      key: 'k',
      now: 6,
      fetch: fetchOnce({
        model_remains: [
          {
            model_name: 'video',
            current_interval_remaining_percent: 1,
            current_weekly_remaining_percent: 1,
            end_time: 1_800_000_000_000,
            weekly_end_time: 1_800_100_000_000,
          },
          {
            model_name: 'general',
            current_interval_remaining_percent: 40,
            current_weekly_remaining_percent: 90,
            end_time: '2026-11-03T10:00:00Z',
            weekly_end_time: '2026-11-10T00:00:00Z',
          },
        ],
        base_resp: { status_code: 0 },
      }),
    })
    expect(usage.limits.map((limit) => [limit.window, limit.usedPercent])).toEqual([
      ['five_hour', 60],
      ['weekly', 10],
    ])
    const failed = await readProviderUsage({
      providerId: 'minimax-coding-plan',
      key: 'k',
      now: 6,
      fetch: fetchOnce({ base_resp: { status_code: 1004, status_msg: 'invalid api key sk-leak' } }),
    })
    expect(failed).toEqual(failedUsage(6))
    expect(JSON.stringify(failed)).not.toContain('sk-leak')
  })

  it('does not use the video bucket as the text quota', async () => {
    expect(
      await readProviderUsage({
        providerId: 'minimax-coding-plan',
        key: 'k',
        now: 6,
        fetch: fetchOnce({
          model_remains: [
            {
              model_name: 'video',
              current_interval_remaining_percent: 1,
              current_weekly_remaining_percent: 1,
            },
          ],
          base_resp: { status_code: 0 },
        }),
      }),
    ).toEqual(failedUsage(6))
  })

  it('turns a failed request, a redirect and a malformed answer into one generic error', async () => {
    const server = await readProviderUsage({
      providerId: 'deepseek',
      key: 'sk-leak',
      now: 8,
      fetch: fetchOnce({ error: 'bad key sk-leak' }, 500),
    })
    expect(server).toEqual(failedUsage(8))
    expect(JSON.stringify(server)).not.toContain('sk-leak')

    const redirect = await readProviderUsage({
      providerId: 'deepseek',
      key: 'sk-leak',
      now: 8,
      fetch: vi.fn(async () => {
        throw new TypeError('unexpected redirect')
      }) as unknown as typeof globalThis.fetch,
    })
    expect(redirect).toEqual(failedUsage(8))

    const malformed = await readProviderUsage({
      providerId: 'deepseek',
      key: 'k',
      now: 8,
      fetch: fetchOnce({ balance_infos: 'no' }),
    })
    expect(malformed).toEqual(failedUsage(8))
  })

  it('refuses an answer larger than the bound without reading it all', async () => {
    const usage = await readProviderUsage({
      providerId: 'deepseek',
      key: 'k',
      now: 8,
      fetch: fetchOnce({ balance_infos: [], padding: 'x'.repeat(70 * 1024) }),
    })
    expect(usage).toEqual(failedUsage(8))
  })

  it('uses one generic error text', () => {
    expect(USAGE_ERROR).toBe('Usage could not be read.')
  })
})

describe('mapNativeUsage', () => {
  const GO = {
    rolling: { percent: 20, limited: false, resetsAt: 1_800_000_000_000 },
    weekly: { percent: 55, limited: false, resetsAt: 1_800_100_000_000 },
    monthly: { percent: 100, limited: true, resetsAt: 1_800_200_000_000 },
  }

  it('reads the Go windows and the Console budgets', () => {
    const usage = mapNativeUsage(
      {
        workspace: { id: 'ws', name: 'Work', usageURL: 'https://opencode.ai/usage' },
        go: GO,
        budgets: [
          {
            id: 'b1',
            limit: 20,
            spent: 4,
            scope: 'each',
            per: 'set',
            coverage: 'all',
            models: [],
            vendors: [],
            picked: true,
            shared: false,
            resetsAt: 1_800_300_000_000,
          },
          {
            id: 'b2',
            limit: 10,
            spent: 9,
            scope: 'each',
            per: 'model',
            coverage: 'models',
            models: [],
            vendors: [],
            picked: false,
            shared: false,
            resetsAt: 1_800_400_000_000,
          },
        ],
      },
      10,
    )
    expect(usage.state).toBe('ready')
    expect(
      usage.limits.map((limit) => [limit.window, limit.label, limit.usedPercent, limit.state]),
    ).toEqual([
      ['rolling', 'Rolling', 20, 'ok'],
      ['weekly', 'Weekly', 55, 'ok'],
      ['monthly', 'Monthly', 100, 'reached'],
      ['budget_b1', 'Monthly budget', 20, 'ok'],
      ['budget_b2', 'Monthly budget', 90, 'ok'],
    ])
    expect(usage.limits[3]?.resetsAt).toBe(1_800_300_000_000)
    expect(usage.limits[4]?.resetsAt).toBe(1_800_400_000_000)
    expect(usage.observedAt).toBe(10)
  })

  it('says unsupported when the workspace is not signed in', () => {
    expect(mapNativeUsage(null, 10)).toEqual(unsupportedUsage(10))
  })

  it('says unsupported for a signed-in workspace without limits', () => {
    expect(
      mapNativeUsage(
        { workspace: { id: 'ws', usageURL: 'https://opencode.ai/usage' }, budgets: [] },
        10,
      ),
    ).toMatchObject({ state: 'ready', limits: [] })
  })

  it('reports malformed data as an error', () => {
    expect(mapNativeUsage({ workspace: 'no' }, 10)).toEqual(failedUsage(10))
  })
})
