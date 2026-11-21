// Problems a Marketplace check found, in two languages.

import type { MarketProblem } from '@shared/market-publish'
import type { HostKey } from '../i18n'
import { english, user, type Say } from '../localized-error'

type Params = Record<string, string | number>

/**
 * A problem a check found: `message` in English, which agents and logs read, and `text` in the
 * user's language for the interface when that differs.
 */
export function problemWith(path: string | undefined, build: (say: Say) => string): MarketProblem {
  const message = build(english)
  const text = build(user)
  return { ...(path === undefined ? {} : { path }), message, ...(text === message ? {} : { text }) }
}

export function problem(path: string | undefined, key: HostKey, params?: Params): MarketProblem {
  return problemWith(path, (say) => say(key, params))
}

/** A problem that is a failure's two texts. */
export function problemOf(message: string, text: string): MarketProblem {
  return { message, ...(text === message ? {} : { text }) }
}

/** The problems as an agent reads them, without the interface's text. */
export function forAgent(problems: readonly MarketProblem[]): MarketProblem[] {
  return problems.map(({ path, message }) => ({ ...(path === undefined ? {} : { path }), message }))
}
