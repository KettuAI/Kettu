import { amountLimit, number, object, type VendorUsage } from './common'
import { requestOverStdio } from './stdio-rpc'

export function parseCopilotQuota(value: unknown, now: number): VendorUsage | null {
  const body = object(value)
  if (!body) return null
  const quota = object(body.quota_snapshots) ?? object(body.quota) ?? body
  const premium = object(quota.premium_interactions) ?? object(quota.premiumRequests)
  const credits = object(quota.ai_credits) ?? object(quota.aiCredits)
  const selected = premium ?? credits
  const total = number(selected?.entitlement ?? selected?.total ?? selected?.limit)
  const used =
    number(selected?.used ?? selected?.consumed) ??
    (() => {
      const remaining = number(selected?.quota_remaining)
      return total !== null && remaining !== null ? total - remaining : null
    })()
  if (used === null || total === null || total <= 0) return null
  return {
    limits: [amountLimit('monthly', 'Monthly', used, total, premium ? 'requests' : 'credits', now)],
    balances: [],
  }
}

export async function readCopilotQuota(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<VendorUsage | null> {
  const reply = await requestOverStdio(command, args, env, [
    {
      method: 'connect',
      params: { clientInfo: { name: 'Kettu', version: '0.1.0' }, supportedTaskKinds: ['agent'] },
    },
    { method: 'account.getQuota' },
  ])
  return parseCopilotQuota(reply, now)
}
