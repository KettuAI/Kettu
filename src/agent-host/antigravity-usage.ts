// Google Antigravity's plan limits and G1 credits, read with the user's own `agy`, whose print mode
// answers `/usage` and `/credits` itself with its own sign-in (see vendor-usage/antigravity.ts).
// Signed out, agy answers them by opening a browser to sign in, so a read stops it at once.

import type { Platform } from '@shared/platform'
import { runProgram, type ProgramOptions, type ProgramRun } from './adapter-install'
import { AgentRequestError } from './connection'
import type { Env } from './find-command'
import { t } from './i18n'
import type { VendorUsage } from './vendor-usage/common'
import {
  parseAntigravityCredits,
  parseAntigravityUsage,
  replyError,
} from './vendor-usage/antigravity'

/** The line agy 1.5.9 prints as it opens its browser sign-in. */
const SIGN_IN_PROMPT = /Authentication required/i

export interface AntigravityUsageDeps {
  /** The agent's name, for the errors. */
  name: string
  /** The user's `agy`. */
  program: string
  /** What goes before the print mode's arguments. */
  args: readonly string[]
  /** The agent's environment. */
  env: Env
  /** A folder of Kettu's own, so no project of the user's is involved. */
  cwd: string
  platform: Platform
  timeoutMs: number
  /** Runs the program; tests pass their own. */
  run?: (options: ProgramOptions) => Promise<ProgramRun>
}

/** agy's JSON reply to one print-mode command. */
async function ask(deps: AntigravityUsageDeps, command: 'usage' | 'credits'): Promise<unknown> {
  const abort = new AbortController()
  let signIn = false
  const run = await (deps.run ?? runProgram)({
    program: deps.program,
    args: [...deps.args, '-p', `/${command}`, '--output-format', 'json'],
    cwd: deps.cwd,
    env: deps.env,
    platform: deps.platform,
    timeoutMs: deps.timeoutMs,
    signal: abort.signal,
    onOutput: (text) => {
      if (signIn || !SIGN_IN_PROMPT.test(text)) return
      signIn = true
      abort.abort()
    },
  })
  if (signIn) {
    throw new AgentRequestError(
      'auth_required',
      t('agent.antigravitySignedOut', { agent: deps.name }),
    )
  }
  if (run.timedOut) {
    throw new Error(t('agent.antigravity.noAnswer', { command, seconds: deps.timeoutMs / 1000 }))
  }
  if (run.error) throw new Error(t('agent.program.notStarted', { name: 'agy', error: run.error }))
  try {
    return JSON.parse(run.stdout) as unknown
  } catch {
    throw new Error(t('agent.antigravity.noJson', { command, code: String(run.code) }))
  }
}

/**
 * Reads the account's quota groups with `agy -p "/usage"`, then its G1 credits with `/credits`;
 * only for a Google or Gemini Enterprise sign-in. Credits that cannot be read leave the limits.
 */
export async function readAntigravityUsage(
  deps: AntigravityUsageDeps,
  now: number,
): Promise<VendorUsage> {
  const reply = await ask(deps, 'usage')
  const failed = replyError(reply)
  if (failed !== null) {
    throw new Error(t('agent.antigravityLimitsFailed', { agent: deps.name, error: failed }))
  }
  const usage = parseAntigravityUsage(reply, now)
  if (!usage) {
    throw new Error(t('agent.unreadableLimits', { agent: deps.name, command: '/usage' }))
  }
  const credits = await ask(deps, 'credits').then(parseAntigravityCredits, () => null)
  return credits ? { ...usage, balances: [credits] } : usage
}
