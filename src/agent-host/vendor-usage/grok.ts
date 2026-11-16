import type { PlanLimit } from '@shared/agent-host'
import { balance, number, object, percentLimit, type VendorUsage } from './common'

export function parseGrokBilling(value: unknown, now: number): VendorUsage | null {
  const body = object(value)
  if (!body) return null
  const limits: PlanLimit[] = []
  const percent = number(body.creditUsagePercent)
  const period = object(body.currentPeriod)
  if (percent !== null) {
    const window = String(
      period?.type ?? period?.unit ?? body.currentPeriod ?? 'weekly',
    ).toLowerCase()
    limits.push(
      percentLimit(
        window.includes('month') ? 'monthly' : 'seven_day',
        window.includes('month') ? 'Monthly' : 'Weekly',
        percent,
        now,
      ),
    )
  }
  const prepaid = number(body.prepaidBalance)
  const balances = prepaid === null ? [] : [balance('Prepaid balance', prepaid, 'USD')]
  if (percent === null && balances.length === 0) return null
  return {
    tier: typeof body.subscription_tier === 'string' ? body.subscription_tier : undefined,
    limits,
    balances,
  }
}
