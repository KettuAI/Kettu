// The DeepSeek account balance: where its token goes, and what an answer the read cannot trust
// shows instead of a balance.

import { describe, expect, it, vi } from 'vitest'
import { readAccountBalance, SUMMARY_URL } from './balance'

const NOW = 1_700_000_000_000
const TOKEN = 'grant-secret'

function answer(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as never
}

function summary(bizData: unknown, code = 0, bizCode = 0): unknown {
  return { code, msg: '', data: { biz_code: bizCode, biz_msg: '', biz_data: bizData } }
}

describe('DeepSeek account balance', () => {
  it('sends the token only in its header, only to the platform, without following redirects', async () => {
    const fetch = answer(summary({ normal_wallets: [], bonus_wallets: [] }))
    await readAccountBalance({ token: TOKEN, now: NOW, fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('https://platform.deepseek.com/api/v0/users/get_user_summary')
    expect(url).toBe(SUMMARY_URL)
    expect(init?.redirect).toBe('error')
    expect(init?.headers).toEqual({ accept: 'application/json', 'x-dsh-auth-token': TOKEN })
  })

  it('shows the recharge and bonus wallets apart, and keeps nothing else', async () => {
    const read = await readAccountBalance({
      token: TOKEN,
      now: NOW,
      fetch: answer(
        summary({
          normal_wallets: [
            { currency: 'CNY', balance: '9.9953309600000000', token_estimation: '0' },
          ],
          bonus_wallets: [{ currency: 'CNY', balance: '0E-16', token_estimation: '0' }],
          total_costs: [{ currency: 'CNY', amount: '23.5' }],
        }),
      ),
    })
    expect(read.expired).toBe(false)
    expect(read.usage).toEqual({
      state: 'ready',
      limits: [],
      balances: [
        { label: 'Recharge balance', amount: 9.99533096, currency: 'CNY' },
        { label: 'Bonus balance', amount: 0, currency: 'CNY' },
      ],
      observedAt: NOW,
      error: null,
    })
  })

  it('reads a 401 or response code 40003 as an expired sign-in', async () => {
    for (const fetch of [answer({}, 401), answer({ code: 40003, msg: 'invalid' })]) {
      const read = await readAccountBalance({ token: TOKEN, now: NOW, fetch })
      expect(read.expired).toBe(true)
      expect(read.usage.state).toBe('error')
      expect(read.usage.balances).toEqual([])
    }
  })

  it('fails, never a zero, on an answer it cannot trust', async () => {
    const answers = [
      answer({}, 500),
      answer(summary({ normal_wallets: [], bonus_wallets: [] }, 0, 1)),
      answer(summary({ normal_wallets: [], bonus_wallets: [] }, 1)),
      answer(summary({ normal_wallets: [{ currency: 'CNY', balance: 'NaN' }], bonus_wallets: [] })),
      answer(summary({ normal_wallets: [{ currency: 'CNY', balance: 5 }], bonus_wallets: [] })),
      answer(summary({ normal_wallets: [{ currency: 'cny', balance: '5' }], bonus_wallets: [] })),
      answer(summary({ normal_wallets: [] })),
      vi.fn(async () => {
        throw new Error(`refused ${TOKEN}`)
      }) as never,
    ]
    for (const fetch of answers) {
      const read = await readAccountBalance({ token: TOKEN, now: NOW, fetch })
      expect(read.expired).toBe(false)
      expect(read.usage.state).toBe('error')
      expect(read.usage.balances).toEqual([])
      expect(JSON.stringify(read)).not.toContain(TOKEN)
    }
  })
})
