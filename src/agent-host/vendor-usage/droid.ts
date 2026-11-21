// Factory Droid's plan usage, as Droid's /status asks `/api/billing/limits` (0.251.0): the
// standard 5-hour, weekly and monthly windows and the extra usage balance. Only a key in
// `FACTORY_API_KEY` is used; Droid's own sign-in is encrypted or in the system keychain.
// Follows Magpie, https://github.com/yetone/magpie/blob/3b643f3/internal/provider/factory_usage.go
// Copyright (c) 2026 yetone. MIT License.

import type { PlanLimit } from '@shared/agent-host'
import { t } from '../i18n'
import { balance, number, object, percentLimit, time, type VendorUsage } from './common'
import { askVendor, UsageReadError, variable, type SignInPlace } from './stored-sign-in'

const VENDOR = 'Factory Droid'

export const FACTORY_ORIGINS = ['https://api.factory.ai'] as const

const WINDOWS = [
  ['fiveHour', 'five_hour', '5-hour'],
  ['weekly', 'seven_day', 'Weekly'],
  ['monthly', 'monthly', 'Monthly'],
] as const

/** The standard windows and the extra usage balance; null when the reply has neither. */
export function parseFactoryLimits(value: unknown, now: number): VendorUsage | null {
  const root = object(value)
  if (!root) return null
  const standard = object(object(root.limits)?.standard)
  const limits: PlanLimit[] = []
  for (const [key, id, label] of WINDOWS) {
    const window = object(standard?.[key])
    const used = number(window?.usedPercent)
    if (used === null) continue
    limits.push(percentLimit(id, label, used, now, time(window?.windowEnd)))
  }
  const cents = number(root.extraUsageBalanceCents)
  const extra =
    cents !== null && (cents > 0 || root.extraUsageAllowed === true)
      ? [balance('Extra usage', cents / 100, 'USD')]
      : []
  if (limits.length === 0 && extra.length === 0) return null
  return { limits, balances: extra }
}

export async function readFactoryLimits(place: SignInPlace): Promise<VendorUsage> {
  const key = variable(place, 'FACTORY_API_KEY')
  if (!key) throw new UsageReadError(t('usageRead.noFactoryKey', { vendor: VENDOR }))
  const reply = await askVendor(
    {
      vendor: VENDOR,
      origins: FACTORY_ORIGINS,
      url: `${FACTORY_ORIGINS[0]}/api/billing/limits`,
      headers: { authorization: `Bearer ${key}` },
    },
    place,
  )
  const usage = parseFactoryLimits(reply, place.now)
  if (!usage) throw new UsageReadError(t('usageRead.noPlanUsage', { vendor: VENDOR }))
  return usage
}
