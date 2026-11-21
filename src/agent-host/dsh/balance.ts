// A DeepSeek account's wallets, from the summary DeepSeek's platform gives dsh's own account pages.
// The sign-in's token goes in one request header to that platform and nowhere else, and never
// reaches a result.

import type { ProviderBalance } from '@shared/agent-host'
import { t } from '../i18n'
import { failedUsage, type ProviderUsage } from '../opencode/provider-usage'
import { object, readBody } from '../vendor-usage/common'
import { ACCOUNT_ORIGIN } from './credentials'

export const SUMMARY_URL = `${ACCOUNT_ORIGIN}/api/v0/users/get_user_summary`
/** What the platform answers a token it no longer accepts with, besides HTTP 401. */
const INVALID_AUTHORIZATION = 40003
const TIMEOUT = 15_000
// The platform sends amounts as decimal strings, such as 9.9953309600000000 or 0E-16.
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

export interface AccountBalance {
  usage: ProviderUsage
  /** The platform no longer accepts the sign-in, which only signing in again in dsh renews. */
  expired: boolean
}

export interface AccountBalanceQuery {
  token: string
  now: number
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

/** One row per wallet, or null when the list does not read, which fails the whole read. */
function wallets(value: unknown, label: string): ProviderBalance[] | null {
  if (!Array.isArray(value)) return null
  const rows: ProviderBalance[] = []
  for (const item of value) {
    const wallet = object(item)
    const currency = wallet?.currency
    const balance = wallet?.balance
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null
    if (typeof balance !== 'string' || !DECIMAL.test(balance)) return null
    rows.push({ label, amount: Number(balance), currency })
  }
  return rows
}

function expired(now: number): AccountBalance {
  return {
    usage: {
      state: 'error',
      limits: [],
      balances: [],
      observedAt: now,
      error: t('dsh.balanceExpired'),
    },
    expired: true,
  }
}

/** Asks the platform for the account's recharge and bonus wallets; a failure is never a zero. */
export async function readAccountBalance(query: AccountBalanceQuery): Promise<AccountBalance> {
  const failed: AccountBalance = { usage: failedUsage(query.now), expired: false }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), query.timeoutMs ?? TIMEOUT)
  try {
    const response = await (query.fetch ?? globalThis.fetch)(SUMMARY_URL, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-dsh-auth-token': query.token },
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status === 401) return expired(query.now)
    if (!response.ok) return failed
    const body = object(JSON.parse(await readBody(response)))
    if (body?.code === INVALID_AUTHORIZATION) return expired(query.now)
    const data = object(body?.data)
    if (body?.code !== 0 || data?.biz_code !== 0) return failed
    const summary = object(data.biz_data)
    const recharge = wallets(summary?.normal_wallets, 'Recharge balance')
    const bonus = wallets(summary?.bonus_wallets, 'Bonus balance')
    if (!recharge || !bonus) return failed
    return {
      usage: {
        state: 'ready',
        limits: [],
        balances: [...recharge, ...bonus],
        observedAt: query.now,
        error: null,
      },
      expired: false,
    }
  } catch {
    return failed
  } finally {
    clearTimeout(timer)
  }
}
