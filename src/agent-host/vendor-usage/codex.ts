// Codex's rate-limit reset credits, which its app-server does not report: read from the ChatGPT
// backend the Codex CLI itself asks (CLI 0.170.0), with the ChatGPT sign-in the CLI keeps in its
// auth.json. The token is read in memory for the requests and dropped.

import path from 'node:path'
import type { PlanResets, ResetSpendCode } from '@shared/agent-host'
import { t } from '../i18n'
import { number, object, time } from './common'
import {
  askVendor,
  parseSignIn,
  readSignInFile,
  UsageReadError,
  type SignInPlace,
} from './stored-sign-in'

const VENDOR = 'ChatGPT'
const ORIGIN = 'https://chatgpt.com'
export const CODEX_ORIGINS = [ORIGIN] as const
const API = `${ORIGIN}/backend-api/wham`

/** The CLI version these requests and replies were checked on. */
export const CODEX_RESETS_VERSION = '0.170.0'

/** The details are worth a short wait only: the count alone still shows. */
const DETAILS_MS = 4_000

const SPEND_CODES: readonly ResetSpendCode[] = [
  'reset',
  'nothing_to_reset',
  'no_credit',
  'already_redeemed',
]

/** Where a Codex read finds the sign-in: the CLI's own folder, and the version that asks. */
export interface CodexPlace extends SignInPlace {
  /** The CLI's folder: `CODEX_HOME`, or `.codex` in the home folder. */
  folder: string
  version: string
}

interface SignIn {
  token: string
  account: string
}

/** The claims of a JWT, unverified: only what the CLI itself reads from its own token. */
function claims(jwt: unknown): Record<string, unknown> | null {
  if (typeof jwt !== 'string') return null
  const payload = jwt.split('.')[1]
  if (!payload) return null
  try {
    return object(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

/** The ChatGPT sign-in the CLI keeps; null when it keeps none there, as on an API key. */
async function signIn(place: CodexPlace): Promise<SignIn | null> {
  const text = await readSignInFile(path.join(place.folder, 'auth.json'))
  if (text === null) return null
  const tokens = object(object(parseSignIn(text))?.tokens)
  const token = typeof tokens?.access_token === 'string' ? tokens.access_token.trim() : ''
  const account = object(
    claims(tokens?.id_token)?.['https://api.openai.com/auth'],
  )?.chatgpt_account_id
  if (!token || typeof account !== 'string' || !account) return null
  return { token, account }
}

function ask(
  signedIn: SignIn,
  place: CodexPlace,
  request: { path: string; body?: string; timeoutMs?: number },
): Promise<unknown> {
  return askVendor(
    {
      vendor: VENDOR,
      origins: CODEX_ORIGINS,
      url: `${API}${request.path}`,
      method: request.body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${signedIn.token}`,
        'chatgpt-account-id': signedIn.account,
        originator: 'codex_cli_rs',
        'user-agent': `codex_cli_rs/${place.version}`,
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    },
    place,
  )
}

/** How many credits the account holds, from its usage; null when the reply names none. */
export function parseCodexResetCount(usage: unknown): number | null {
  const count = number(object(object(usage)?.rate_limit_reset_credits)?.available_count)
  return count !== null && Number.isInteger(count) && count >= 0 ? count : null
}

/**
 * The available credits, the soonest to run out first and those that never do last. Null when
 * the reply cannot be read or lists another number of them than `count`: while one is being spent
 * the two disagree, and a wrong expiry must not be paired with a credit.
 */
export function parseCodexResetCredits(reply: unknown, count: number): PlanResets['each'] | null {
  const listed = object(reply)?.credits
  if (!Array.isArray(listed)) return null
  const each: NonNullable<PlanResets['each']> = []
  for (const item of listed) {
    const credit = object(item)
    if (credit?.status !== 'available') continue
    if (typeof credit.id !== 'string' || !credit.id) return null
    const until = credit.expires_at === null ? null : time(credit.expires_at)
    if (credit.expires_at !== null && until === null) return null
    each.push({ id: credit.id, until })
  }
  if (each.length !== count) return null
  return each.sort((a, b) =>
    a.until === null ? (b.until === null ? 0 : 1) : b.until === null ? -1 : a.until - b.until,
  )
}

/** What a read of the credits found, and how the read of their expiries went. */
export interface CodexResetsRead {
  resets: PlanResets
  details: 'read' | 'failed' | 'sign-in-expired'
}

/**
 * Reads the credits the account holds: their number from the usage read, then each one's expiry,
 * asked only when there are any. Null when the CLI keeps no ChatGPT sign-in. A failed details read
 * leaves the number alone, its expiries unknown.
 */
export async function readCodexResets(place: CodexPlace): Promise<CodexResetsRead | null> {
  const signedIn = await signIn(place)
  if (!signedIn) return null
  const count = parseCodexResetCount(await ask(signedIn, place, { path: '/usage' }))
  if (count === null) throw new UsageReadError(t('usageRead.noResets', { vendor: VENDOR }))
  if (count === 0) return { resets: { count, each: [], observedAt: place.now }, details: 'read' }
  let each: PlanResets['each'] | null = null
  let expired = false
  try {
    each = parseCodexResetCredits(
      await ask(signedIn, place, { path: '/rate-limit-reset-credits', timeoutMs: DETAILS_MS }),
      count,
    )
  } catch (error) {
    if (!(error instanceof UsageReadError)) throw error
    expired = error.status === 401
  }
  return {
    resets: { count, ...(each ? { each } : {}), observedAt: place.now },
    details: each ? 'read' : expired ? 'sign-in-expired' : 'failed',
  }
}

/**
 * Spends one credit, which cannot be undone. `requestId` is the vendor's idempotency key: asking
 * again with the same one spends the same credit, never a second.
 */
export async function spendCodexReset(
  place: CodexPlace,
  creditId: string,
  requestId: string,
): Promise<ResetSpendCode> {
  const signedIn = await signIn(place)
  if (!signedIn) throw new UsageReadError(t('usageRead.notSignedIn', { vendor: VENDOR }))
  const reply = await ask(signedIn, place, {
    path: '/rate-limit-reset-credits/consume',
    body: JSON.stringify({ credit_id: creditId, redeem_request_id: requestId }),
  })
  const code = object(reply)?.code
  const known = SPEND_CODES.find((item) => item === code)
  if (!known) throw new UsageReadError(t('usageRead.unknownAnswer', { vendor: VENDOR }))
  return known
}
