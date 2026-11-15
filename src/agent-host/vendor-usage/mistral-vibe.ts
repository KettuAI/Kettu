import type { PlanLimit } from '@shared/agent-host'
import { number, object, percentLimit, type VendorUsage } from './common'

export function parseMistralAccount(value: unknown, now: number): VendorUsage | null {
  const body = object(value)
  const account = object(body?.account) ?? body
  const budget = object(account?.budget)
  const percent = number(budget?.usage_percentage)
  if (!account || percent === null) return null
  const reset =
    typeof budget?.reset_at === 'string' ? Date.parse(budget.reset_at) : number(budget?.reset_at)
  const limits: PlanLimit[] = [
    percentLimit('monthly', 'Monthly', percent, now, reset !== null && reset > 0 ? reset : null),
  ]
  const plan = object(account.plan)
  return {
    tier: typeof plan?.name === 'string' ? plan.name : undefined,
    limits,
    balances: [],
  }
}
