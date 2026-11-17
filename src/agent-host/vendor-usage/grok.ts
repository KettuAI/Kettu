import type { AgentAccount, PlanLimit, ProviderBalance } from '@shared/agent-host'
import { balance, number, object, percentLimit, time, type VendorUsage } from './common'

/** The Grok version whose `x.ai/auth/info` and `x.ai/billing` replies were checked. */
export const GROK_READS_VERSION = '1.0.88'

/** The method Grok declares once a sign-in is cached; it loads that sign-in, it starts none. */
export const GROK_CACHED_SIGN_IN = 'cached_token'

export interface GrokSignIn {
  state: 'authenticated' | 'unauthenticated'
  /** The signed-in account; a subscription's plan comes from the billing reply, so its label is empty. */
  account: AgentAccount | null
}

/** The reply of `x.ai/auth/info`, which answers without signing in: no method means signed out. */
export function parseGrokAuthInfo(value: unknown): GrokSignIn | null {
  const body = object(value)
  if (!body || !('methodId' in body)) return null
  if (body.methodId === null) return { state: 'unauthenticated', account: null }
  if (typeof body.methodId !== 'string' || !body.methodId) return null
  const email = typeof body.email === 'string' && body.email ? body.email : null
  const key = body.methodId.includes('api_key')
  return {
    state: 'authenticated',
    account: { kind: key ? 'api_key' : 'account', label: key ? 'xAI API key' : '', email },
  }
}

/** A proto money value, `{ val }` in cents, as dollars. */
function dollars(value: unknown): number | null {
  const cents = number(object(value)?.val)
  return cents === null ? null : cents / 100
}

/** The reply of `x.ai/billing`: the plan's period under `config`, the tier beside it. */
export function parseGrokBilling(value: unknown, now: number): VendorUsage | null {
  const body = object(value)
  const config = object(body?.config)
  if (!body || !config) return null
  const limits: PlanLimit[] = []
  const period = object(config.currentPeriod)
  if (period) {
    const kind = typeof period.type === 'string' ? period.type.toLowerCase() : ''
    const [window, label] = kind.includes('month')
      ? ['monthly', 'Monthly']
      : kind.includes('day')
        ? ['daily', 'Daily']
        : ['seven_day', 'Weekly']
    // proto3 JSON leaves a zero out, so a period without a percent has used none of it.
    const used = config.creditUsagePercent === undefined ? 0 : number(config.creditUsagePercent)
    if (used === null) return null
    limits.push(
      percentLimit(window, label, used, now, time(period.end) ?? time(config.billingPeriodEnd)),
    )
  }
  const cap = dollars(config.onDemandCap)
  if (cap !== null && cap > 0) {
    const spent = dollars(config.onDemandUsed) ?? 0
    limits.push({
      ...percentLimit('on_demand', 'On-demand', (spent / cap) * 100, now),
      amount: { used: spent, total: cap, unit: 'USD' },
    })
  }
  const prepaid = dollars(config.prepaidBalance)
  const balances: ProviderBalance[] =
    prepaid !== null && prepaid > 0 ? [balance('Prepaid balance', prepaid, 'USD')] : []
  const tier =
    typeof body.subscription_tier === 'string' && body.subscription_tier
      ? body.subscription_tier
      : undefined
  if (limits.length === 0 && balances.length === 0 && !tier) return null
  return { ...(tier ? { tier } : {}), limits, balances }
}
