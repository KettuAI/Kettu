import type { PlanLimit } from '@shared/agent-host'
import { amountLimit, number, object, type VendorUsage } from './common'
import { runProgram } from '../adapter-install'
import { t } from '../i18n'

export function parseAuggieAccount(value: unknown, now: number): VendorUsage | null {
  const body = object(value)
  const account = object(body?.account) ?? body
  if (!account) return null
  const cycle = object(account?.cycle) ?? object(account?.usage) ?? account
  if (!cycle) return null
  const remaining = number(
    cycle.amountRemaining ?? cycle.credits_remaining ?? cycle.remaining_credits ?? cycle.remaining,
  )
  const total = number(
    cycle.amountIncludedPerCycle ?? cycle.credits_total ?? cycle.total_credits ?? cycle.total,
  )
  if (remaining === null || total === null || total <= 0) return null
  const unit = typeof cycle.usageUnit === 'string' ? cycle.usageUnit : 'credits'
  const limits: PlanLimit[] = [
    amountLimit('monthly', 'Monthly', total - remaining, total, unit, now),
  ]
  const end = cycle.billingCycleEndDate ?? cycle.cycle_end ?? cycle.cycle_end_at ?? cycle.end_date
  const reset = typeof end === 'string' ? Date.parse(end) : number(end)
  if (reset !== null && reset > 0) limits[0].resetsAt = reset < 1e12 ? reset * 1000 : reset
  const tier = account.planName ?? account.plan
  return { tier: typeof tier === 'string' ? tier : undefined, limits, balances: [] }
}

export async function readAuggieAccount(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  now: number,
): Promise<VendorUsage | null> {
  const run = await runProgram({
    program: command,
    args: [...args.filter((arg) => arg !== '--acp'), 'account', 'status', '--json'],
    cwd,
    env,
    platform: process.platform,
    timeoutMs: 15_000,
  })
  if (run.code !== 0 || run.error || run.timedOut) throw new Error(t('usageRead.auggieFailed'))
  return parseAuggieAccount(JSON.parse(run.stdout), now)
}
