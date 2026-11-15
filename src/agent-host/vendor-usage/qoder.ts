import type { PlanLimit } from '@shared/agent-host'
import { amountLimit, balance, number, object, type VendorUsage } from './common'
import { requestOverStdio } from './stdio-rpc'

export function parseQoderUsage(value: unknown, now: number): VendorUsage | null {
  const body = object(value)
  const usage = object(body?.accountUsage) ?? object(body?.usage) ?? object(body?.data) ?? body
  if (!usage) return null
  const quota = object(usage?.userQuota) ?? object(usage?.quota) ?? usage
  if (!quota) return null
  const used = number(quota.used ?? quota.credits_used ?? quota.used_credits)
  const total = number(quota.total ?? quota.credits_total ?? quota.total_credits)
  if (used === null || total === null || total <= 0) return null
  const limits: PlanLimit[] = [amountLimit('monthly', 'Monthly', used, total, 'credits', now)]
  const addOn = object(usage.addOnQuota ?? usage.add_on_quota)
  const remaining = number(addOn?.remaining)
  const balances = remaining === null ? [] : [balance('Add-on credits', remaining, 'credits')]
  return { tier: typeof usage.plan === 'string' ? usage.plan : undefined, limits, balances }
}

export async function readQoderUsage(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<VendorUsage | null> {
  const reply = await requestOverStdio(command, args, env, [
    { method: 'daemon.initialize' },
    { method: 'daemon.get_usage_info' },
  ])
  return parseQoderUsage(reply, now)
}
