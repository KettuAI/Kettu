// Cursor's plan usage, as the Cursor CLI's own client reads it from its Dashboard service (CLI
// 2026.10.22): with the access token the CLI keeps, in the macOS keychain by default, else in its
// auth.json. The keychain item is read in memory for the requests and dropped.

import { execFile } from 'node:child_process'
import path from 'node:path'
import type { AgentAccount, PlanLimit } from '@shared/agent-host'
import { number, object, percentLimit, time, type VendorUsage } from './common'
import {
  askVendor,
  parseSignIn,
  readSignInFile,
  UsageReadError,
  variable,
  type SignInPlace,
} from './stored-sign-in'

const VENDOR = 'Cursor'
const ORIGIN = 'https://api2.cursor.sh'
export const CURSOR_ORIGINS = [ORIGIN] as const

/** The keychain item the CLI keeps its access token in: `<app>-access-token` for `<app>-user`. */
const KEYCHAIN = { service: 'cursor-access-token', account: 'cursor-user' }

/** How long a refused keychain prompt is not shown again. */
export const KEYCHAIN_BACKOFF_MS = 10 * 60_000

/** A keychain read's outcome: the secret, no such item, or the user's refusal. */
export type KeychainAnswer = { secret: string } | { missing: true } | { refused: true }

export type KeychainRead = (service: string, account: string) => Promise<KeychainAnswer>

/** Where and how a Cursor read finds the sign-in, beyond what every stored sign-in read gets. */
export interface CursorPlace extends SignInPlace {
  keychain?: KeychainRead
}

/** The keychain refused this read, or did within the backoff. */
export class KeychainRefused extends UsageReadError {
  override name = 'KeychainRefused'
}

let refusedAt: number | null = null

/** Forgets a refusal, so the next read asks the keychain again. */
export function forgetKeychainRefusal(): void {
  refusedAt = null
}

// `security` exits with 44 when no item matches; any other failure is a refusal or a dismissed
// prompt, which it reports the same way.
const MISSING_ITEM = 44

const systemKeychain: KeychainRead = (service, account) =>
  new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeout: 60_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (!error) {
          const secret = stdout.trim()
          resolve(secret ? { secret } : { missing: true })
          return
        }
        const code = (error as { code?: unknown }).code
        resolve(code === MISSING_ITEM ? { missing: true } : { refused: true })
      },
    )
  })

/** The CLI's auth.json, where it keeps the token when it does not use the keychain. */
function authFile(place: SignInPlace): string {
  if (place.platform === 'win32') {
    const roaming = variable(place, 'APPDATA') ?? path.join(place.home, 'AppData', 'Roaming')
    return path.join(roaming, 'Cursor', 'auth.json')
  }
  if (place.platform === 'darwin') return path.join(place.home, '.cursor', 'auth.json')
  const config = variable(place, 'XDG_CONFIG_HOME') ?? path.join(place.home, '.config')
  return path.join(config, 'cursor', 'auth.json')
}

/** The access token the CLI keeps; null when it keeps none. */
async function accessToken(place: CursorPlace): Promise<string | null> {
  const store = variable(place, 'AGENT_CLI_CREDENTIAL_STORE')
  if (place.platform === 'darwin' && store !== 'file' && store !== 'memory') {
    if (refusedAt !== null && place.now - refusedAt < KEYCHAIN_BACKOFF_MS) {
      throw new KeychainRefused(`${VENDOR}'s sign-in in the keychain was not allowed`)
    }
    const answer = await (place.keychain ?? systemKeychain)(KEYCHAIN.service, KEYCHAIN.account)
    if ('refused' in answer) {
      refusedAt = place.now
      throw new KeychainRefused(`${VENDOR}'s sign-in in the keychain was not allowed`)
    }
    refusedAt = null
    if ('secret' in answer) return answer.secret
  }
  const text = await readSignInFile(authFile(place))
  if (text === null) return null
  const token = object(parseSignIn(text))?.accessToken
  return typeof token === 'string' && token.trim() ? token.trim() : null
}

function dashboard(method: string, token: string, place: SignInPlace): Promise<unknown> {
  return askVendor(
    {
      vendor: VENDOR,
      origins: CURSOR_ORIGINS,
      url: `${ORIGIN}/aiserver.v1.DashboardService/${method}`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'connect-protocol-version': '1',
      },
      body: '{}',
    },
    place,
  )
}

/** A percent proto3 JSON leaves out when it is zero. */
function percent(value: unknown): number | null {
  return value === undefined ? 0 : number(value)
}

/**
 * The current period's usage and the plan: a merged plan has one included pool, the others an
 * Auto pool and a pool for the other models beside the total.
 */
export function parseCursorUsage(usage: unknown, plan: unknown, now: number): VendorUsage | null {
  const body = object(usage)
  const pools = object(body?.planUsage)
  if (!body || !pools) return null
  const planBody = object(plan)
  const info = object(planBody?.planInfo)
  const period = typeof info?.includedUsagePeriod === 'string' ? info.includedUsagePeriod : ''
  const [window, label] = period.toLowerCase().includes('week')
    ? ['seven_day', 'Weekly']
    : ['monthly', 'Monthly']
  const resetsAt = time(info?.includedUsageResetsAt) ?? time(body.billingCycleEnd)
  const total = percent(pools.totalPercentUsed)
  if (total === null) return null
  const limits: PlanLimit[] = [percentLimit(window, label, total, now, resetsAt)]
  if (planBody?.isMerged !== true) {
    const auto = percent(pools.autoPercentUsed)
    const other = percent(pools.apiPercentUsed)
    if (auto !== null) limits.push(percentLimit('auto', 'Auto', auto, now, resetsAt))
    if (other !== null) {
      limits.push(percentLimit('other_models', 'Other models', other, now, resetsAt))
    }
  }
  const tier = typeof info?.planName === 'string' && info.planName ? info.planName : undefined
  return { ...(tier ? { tier } : {}), limits, balances: [] }
}

/**
 * Reads the plan usage with the CLI's own access token. A token Cursor refuses is renewed once by
 * the CLI itself, then read again.
 */
export async function readCursorUsage(place: CursorPlace): Promise<VendorUsage> {
  let token = await accessToken(place)
  if (!token && variable(place, 'CURSOR_API_KEY')) {
    // Exchanging a key for a token is not read here until it is checked against a real key.
    throw new UsageReadError(`${VENDOR}'s usage is not read for an API key sign-in yet`)
  }
  if (!token) throw new UsageReadError(`${VENDOR} is not signed in`)
  const read = async (access: string) => {
    const [usage, plan] = await Promise.all([
      dashboard('GetCurrentPeriodUsage', access, place),
      dashboard('GetPlanInfo', access, place),
    ])
    return parseCursorUsage(usage, plan, place.now)
  }
  let usage: VendorUsage | null
  try {
    usage = await read(token)
  } catch (error) {
    if (!(error instanceof UsageReadError) || error.status !== 401 || !place.renew) throw error
    await place.renew()
    token = await accessToken(place)
    if (!token) throw new UsageReadError(`${VENDOR} is not signed in`)
    usage = await read(token)
  }
  if (!usage) throw new UsageReadError(`${VENDOR} sent no plan usage`)
  return usage
}

export interface CursorSignIn {
  state: 'authenticated' | 'unauthenticated'
  account: AgentAccount | null
}

/**
 * The sign-in from `about --format json`, which names the account and its plan. Signed out, it
 * errors when the CLI keeps its sign-in in the keychain and names no account when it keeps it in
 * a file. Null when neither can be read.
 */
export function parseCursorAbout(run: {
  code: number | null
  stdout: string
  stderr: string
}): CursorSignIn | null {
  if (/Authentication required|Not logged in/i.test(`${run.stdout}\n${run.stderr}`)) {
    return { state: 'unauthenticated', account: null }
  }
  if (run.code !== 0) return null
  let body: Record<string, unknown> | null
  try {
    body = object(JSON.parse(run.stdout))
  } catch {
    return null
  }
  if (!body || !('userEmail' in body)) return null
  if (body.userEmail === null) return { state: 'unauthenticated', account: null }
  const email = typeof body.userEmail === 'string' && body.userEmail ? body.userEmail : null
  if (!email) return null
  const tier = typeof body.subscriptionTier === 'string' ? body.subscriptionTier : ''
  return { state: 'authenticated', account: { kind: 'account', label: tier, email } }
}
