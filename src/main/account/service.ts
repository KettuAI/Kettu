// The account service's interface as main and the daemon use it: the shared client, with what
// takes Node.js, the random values a sign-in needs and the service's address from the environment.

import { createHash, randomBytes } from 'node:crypto'
import { ACCOUNT_URL } from '@shared/account-api'

export * from '@shared/account-api'

/** Points a development run at another copy of the service and its pages. */
export const ACCOUNT_URL_ENV = 'KETTU_ACCOUNT_URL'

/** The website and its API, as `KETTU_ACCOUNT_URL` or the project's own. */
export function accountBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env[ACCOUNT_URL_ENV]?.trim()
  if (!raw) return ACCOUNT_URL
  const url = URL.parse(raw)
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.search || url.hash) {
    throw new Error(`${ACCOUNT_URL_ENV} must be an http or https URL without a query`)
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

export interface Pkce {
  verifier: string
  challenge: string
}

/** A code verifier of 43 characters and its S256 challenge (RFC 7636). */
export function newPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function newState(): string {
  return randomBytes(24).toString('base64url')
}
