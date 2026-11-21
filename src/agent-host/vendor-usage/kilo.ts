import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { t } from '../i18n'
import { balance, number, object, type VendorUsage } from './common'

export function parseKiloProfile(value: unknown): VendorUsage | null {
  const body = object(value)
  const profile = object(body?.profile) ?? body
  if (!profile) return null
  const balanceInfo = object(body?.balance)
  const credits = number(balanceInfo?.balance ?? profile.credits ?? profile.credit_balance)
  const pass = object(body?.kiloPass ?? profile.kilo_pass ?? profile.kiloPass)
  if (credits === null && !pass) return null
  const balances = credits === null ? [] : [balance('Prepaid balance', credits, 'USD')]
  const total = number(pass?.currentPeriodBaseCreditsUsd)
  const bonus = number(pass?.currentPeriodBonusCreditsUsd) ?? 0
  const used = number(pass?.currentPeriodUsageUsd)
  const limits =
    total !== null && used !== null
      ? [
          {
            window: 'monthly',
            label: 'Kilo Pass',
            usedPercent: total + bonus > 0 ? Math.min(100, (used / (total + bonus)) * 100) : null,
            resetsAt:
              typeof pass?.nextBillingAt === 'string' ? Date.parse(pass.nextBillingAt) : null,
            state: used >= total + bonus ? ('reached' as const) : ('ok' as const),
            observedAt: Date.now(),
            amount: { used, total: total + bonus, unit: 'USD' },
          },
        ]
      : []
  return { limits, balances }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(t('usageRead.kilo.noPort'))
  const { port } = address
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

/** A final answer, unlike a failed connection while the server is still starting. */
class ProfileRefused extends Error {}

export async function readKiloProfile(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<VendorUsage | null> {
  const port = await freePort()
  const server = spawn(
    command,
    [
      ...args.filter((arg) => arg !== 'acp'),
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      env,
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  try {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(t('usageRead.kilo.exited'))
      try {
        const response = await fetch(`http://127.0.0.1:${port}/kilo/profile`, {
          signal: AbortSignal.timeout(1000),
        })
        if (!response.ok) {
          throw new ProfileRefused(t('usageRead.kilo.refused', { status: response.status }))
        }
        return parseKiloProfile(await response.json())
      } catch (error) {
        if (error instanceof ProfileRefused) throw error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    throw new Error(t('usageRead.kilo.timedOut'))
  } finally {
    if (server.exitCode === null) server.kill()
  }
}
