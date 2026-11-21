// Kimi Code's plan usage, as its own client reads it from /coding/v1/usages (2.6.2): the windows
// and the extra-usage wallet. OpenCode's Kimi Code plan reads the same reply with an API key.
// Follows Magpie, https://github.com/yetone/magpie/blob/3b643f3/internal/provider/planquota.go
// Copyright (c) 2026 yetone. MIT License.

import { createHash } from 'node:crypto'
import path from 'node:path'
import type { PlanLimit, ProviderBalance } from '@shared/agent-host'
import { t } from '../i18n'
import { balance, number, object, percentLimit, time, type VendorUsage } from './common'
import {
  askVendor,
  parseSignIn,
  readSignInFile,
  UsageReadError,
  variable,
  type SignInPlace,
} from './stored-sign-in'

const VENDOR = 'Kimi Code'

/**
 * The two regions Kimi Code signs in to. The mainland's token is the default `kimi-code`, the
 * global one is kept under the key Kimi Code derives from the region's hosts.
 */
const REGIONS = {
  mainland: {
    origin: 'https://api.kimi.com',
    oauthHost: 'https://auth.kimi.com',
    file: 'kimi-code.json',
  },
  global: {
    origin: 'https://api.kimi.ai',
    oauthHost: 'https://auth.kimi.ai',
    file: `kimi-code-env-${createHash('sha256')
      .update(
        JSON.stringify({
          oauthHost: 'https://auth.kimi.ai',
          baseUrl: 'https://api.kimi.ai/coding/v1',
        }),
      )
      .digest('hex')
      .slice(0, 16)}.json`,
  },
} as const

type Region = keyof typeof REGIONS

export const KIMI_CODE_ORIGINS = [REGIONS.mainland.origin, REGIONS.global.origin] as const

/** A share of the plan used, 0 to 1, under Kimi's snake_case or camelCase names. */
function share(
  entry: Record<string, unknown> | null,
): { used: number; resetsAt: number | null } | null {
  const ratio = number(entry?.used_ratio ?? entry?.usedRatio)
  if (ratio === null) return null
  return {
    used: ratio * 100,
    resetsAt: time(entry?.reset_time ?? entry?.resetTime ?? entry?.resetAt ?? entry?.reset_at),
  }
}

/** Used of a counted window, from what is used or what remains; null without a limit. */
function counted(entry: Record<string, unknown> | null): number | null {
  const total = number(entry?.limit)
  if (total === null || total <= 0) return null
  const used = number(entry?.used)
  const remaining = number(entry?.remaining)
  const spent = used ?? (remaining === null ? null : total - remaining)
  return spent === null ? null : (spent / total) * 100
}

/**
 * The booster wallet, "Extra usage": amounts are cents times 10^6, a missing `amountLeft` meaning
 * none is left, in the currency of its monthly limit, else USD.
 */
function boosterWallet(value: unknown): ProviderBalance | null {
  const wallet = object(value)
  const funds = object(wallet?.balance)
  if (!funds || funds.type !== 'BOOSTER') return null
  const amount = number(funds.amount)
  if (amount === null || amount <= 0) return null
  const left = number(funds.amountLeft) ?? 0
  const currency =
    [object(wallet?.monthlyChargeLimit)?.currency, object(wallet?.monthlyUsed)?.currency].find(
      (value): value is string => typeof value === 'string' && value !== '',
    ) ?? 'USD'
  return balance('Extra usage', Math.round(left / 1e6) / 100, currency)
}

const SHARES = [
  ['limit_5h', 'limit5h', 'five_hour', '5-hour'],
  ['limit_7d', 'limit7d', 'seven_day', 'Weekly'],
  ['limit_month_total', 'limitMonthTotal', 'monthly', 'Monthly'],
  // Code's part of the month, or on some plans the month itself with no total beside it.
  ['limit_month_code', 'limitMonthCode', 'monthly', 'Monthly'],
] as const

/** The windows and wallet of a `/coding/v1/usages` reply; null when it is not one. */
export function parseKimiCodeUsage(value: unknown, now: number): VendorUsage | null {
  const root = object(value)
  if (!root) return null
  const limits = new Map<string, PlanLimit>()
  for (const item of Array.isArray(root.limits) ? root.limits : []) {
    const row = object(item)
    const detail = object(row?.detail)
    const used = counted(detail)
    if (used === null) continue
    const window = object(row?.window)
    const duration = number(window?.duration)
    const fiveHour = duration === 300 && window?.timeUnit === 'TIME_UNIT_MINUTE'
    const id = fiveHour ? 'five_hour' : `kimi_${duration ?? 'other'}`
    limits.set(
      id,
      percentLimit(id, fiveHour ? '5-hour' : 'Usage', used, now, time(detail?.resetTime)),
    )
  }
  const weekly = object(root.usage)
  const weeklyUsed = counted(weekly)
  if (weeklyUsed !== null) {
    limits.set(
      'seven_day',
      percentLimit('seven_day', 'Weekly', weeklyUsed, now, time(weekly?.resetTime)),
    )
  }
  // A window told both ways is taken from the shares, as Kimi Code does.
  const usages = object(root.usages)
  const shared = new Set<string>()
  for (const [snake, camel, id, label] of SHARES) {
    if (shared.has(id)) continue
    const read = share(object(usages?.[snake] ?? usages?.[camel]))
    if (!read) continue
    shared.add(id)
    limits.set(id, percentLimit(id, label, read.used, now, read.resetsAt))
  }
  const wallet = boosterWallet(root.boosterWallet ?? root.booster_wallet)
  return { limits: [...limits.values()], balances: wallet ? [wallet] : [] }
}

/** The region Kimi Code signs in to: its environment's sign-in host, else its marker file. */
async function preferredRegion(place: SignInPlace, home: string): Promise<Region> {
  const host = (variable(place, 'KIMI_CODE_OAUTH_HOST') ?? variable(place, 'KIMI_OAUTH_HOST'))
    ?.replace(/\/+$/, '')
    .toLowerCase()
  if (host === REGIONS.global.oauthHost) return 'global'
  if (host) return 'mainland'
  const marker = (await readSignInFile(path.join(home, 'region')))?.trim()
  return marker === 'global' ? 'global' : 'mainland'
}

/**
 * Reads the plan usage with the OAuth token Kimi Code keeps in `credentials/` of its home
 * (`KIMI_CODE_HOME`, else `~/.kimi-code`). The token is never refreshed: an expired one fails.
 */
export async function readKimiCodeUsage(place: SignInPlace): Promise<VendorUsage> {
  const home = variable(place, 'KIMI_CODE_HOME') ?? path.join(place.home, '.kimi-code')
  const first = await preferredRegion(place, home)
  const order: Region[] = first === 'global' ? ['global', 'mainland'] : ['mainland', 'global']
  for (const region of order) {
    const text = await readSignInFile(path.join(home, 'credentials', REGIONS[region].file))
    if (text === null) continue
    const token = object(parseSignIn(text))
    const access = typeof token?.access_token === 'string' ? token.access_token.trim() : ''
    if (!access) continue
    const expiresAt = number(token?.expires_at)
    if (expiresAt !== null && expiresAt > 0 && expiresAt * 1000 <= place.now) {
      throw new UsageReadError(t('usageRead.signInExpired', { vendor: VENDOR }))
    }
    const reply = await askVendor(
      {
        vendor: VENDOR,
        origins: KIMI_CODE_ORIGINS,
        url: `${REGIONS[region].origin}/coding/v1/usages`,
        headers: { authorization: `Bearer ${access}` },
      },
      place,
    )
    const usage = parseKimiCodeUsage(reply, place.now)
    if (!usage || (usage.limits.length === 0 && usage.balances.length === 0)) {
      throw new UsageReadError(t('usageRead.noPlanUsage', { vendor: VENDOR }))
    }
    return usage
  }
  throw new UsageReadError(t('usageRead.notSignedIn', { vendor: VENDOR }))
}
