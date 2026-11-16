// Junie's `/usage` report as build 3893.5 writes it, markdown lines ending in `  \n`. Signed in
// with a JetBrains account it names the account's balance, `Balance left: 12.5 credits` or
// `Balance left: $12.5`; with a connected JetBrains IDE's quota instead it names
// `Quota: 120 / 300 credits remaining`.

import type { PlanLimit, ProviderBalance } from '@shared/agent-host'
import { amountLimit, balance, type VendorUsage } from './common'

/** The build whose report this reads, as Junie names its version in `initialize`. */
export const JUNIE_USAGE_VERSION = '26.10.27 (3893.5)'

/**
 * The credits in a `/usage` report. A report without them, such as one for a model provider's own
 * key, gives empty lists; text that is not the report gives null.
 */
export function parseJunieUsage(markdown: string, now: number): VendorUsage | null {
  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
  if (lines[0] !== 'Session usage') return null
  const limits: PlanLimit[] = []
  const balances: ProviderBalance[] = []
  for (const line of lines) {
    const quota = /^Quota: (\d+) \/ (\d+) credits remaining$/.exec(line)
    const total = quota ? Number(quota[2]) : 0
    if (quota && total > 0) {
      const used = Math.max(0, total - Number(quota[1]))
      limits.push(amountLimit('monthly', 'Monthly', used, total, 'credits', now))
      continue
    }
    const dollars = /^Balance left: \$(\d+(?:\.\d+)?)$/.exec(line)
    if (dollars) {
      balances.push(balance('Balance', Number(dollars[1]), 'USD'))
      continue
    }
    const credits = /^Balance left: (\d+(?:\.\d+)?) credits?$/.exec(line)
    if (credits) balances.push(balance('Balance', Number(credits[1]), 'credits'))
  }
  return { limits, balances }
}
