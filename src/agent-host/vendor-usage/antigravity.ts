// Google Antigravity's plan tier and sign-in metadata.
//
// agy's ACP mode names the plan in the `_meta` of its answers to `authenticate`, `session/new`,
// `session/load` and `session/resume` when signed in with Google, and declares
// `_meta.antigravity.tier` in `initialize`:
// `{ antigravity: { tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri } } }`.
//
// Kettu does not poll Antigravity's `/usage` or `/credits` commands; plan tier metadata comes only
// from normal ACP responses and local auth-state inspection.

import path from 'node:path'
import { object } from './common'

/** The version the plan was checked on, as agy names it in `initialize`; later ones keep it. */
export const ANTIGRAVITY_TIER_VERSION = '1.5.9'

const answerTier = (meta: unknown) => object(object(object(meta)?.antigravity)?.tier)

/** The plan's name in an answer's `_meta`, or null when it names none. */
export function antigravityTier(meta: unknown): string | null {
  const tier = answerTier(meta)
  const name = typeof tier?.name === 'string' ? tier.name.trim() : ''
  return name || null
}

/**
 * Extracts the Ultra tier multiplier (`5x` / `20x`) from `_meta.antigravity.tier`, or null when
 * none matches. Populates `AgentAccount.tier` badges on account cards and menus.
 */
export function antigravityTierMultiple(meta: unknown): string | null {
  const tier = answerTier(meta)
  if (!tier) return null
  const id = typeof tier.id === 'string' ? tier.id.trim().toLowerCase() : ''
  const name = typeof tier.name === 'string' ? tier.name.trim() : ''
  const description = typeof tier.description === 'string' ? tier.description.trim() : ''
  const text = `${id} ${name} ${description}`
  if (/(?:^|[-_\s])5x(?:$|[-_\s])|ultra[-_]?lite/i.test(text)) return '5x'
  if (
    /(?:^|[-_\s])20x(?:$|[-_\s])/i.test(text) ||
    id === 'g1-ultra-tier' ||
    (/^g1-ultra(?:-[a-z0-9]+)?-tier$/i.test(id) && !/lite|5x/i.test(id))
  ) {
    return '20x'
  }
  return null
}

/**
 * The sign-in the plan in an answer's `_meta` shows, by its id: Google's personal plans (the free
 * tier and Google One's `g1-` AI plans) or Gemini Enterprise and Google Cloud ones (`gcp-`,
 * `business-`), the ids agy 1.5.9 knows. Null for an answer with no plan, which an API key or a
 * cloud project gives, or with one of an id Kettu does not know.
 */
export function antigravityTierSignIn(meta: unknown): 'oauth-personal' | 'oauth-business' | null {
  const id = answerTier(meta)?.id
  if (typeof id !== 'string') return null
  if (id === 'free-tier' || id.startsWith('g1-')) return 'oauth-personal'
  if (id.startsWith('gcp-') || id.startsWith('business-')) return 'oauth-business'
  return null
}

/** Sign-in methods backed by a Google or Gemini Enterprise plan rather than an API console. */
export const ANTIGRAVITY_PLAN_SIGN_INS: readonly string[] = ['oauth-personal', 'oauth-business']

/** Where agy 1.5.9 keeps the sign-in method its ACP mode uses, under the home folder. */
export function antigravityAuthStateFile(home: string): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'cache', 'acp-auth-state.json')
}

/**
 * The sign-in method agy last used, from the `methodId` of its
 * `~/.gemini/antigravity-cli/cache/acp-auth-state.json` (1.5.9); null when the file names none.
 * Only that field is read: the file holds no credential, and nothing else of it is kept.
 */
export function antigravitySignInMethod(text: string): string | null {
  try {
    const method = object(JSON.parse(text))?.methodId
    return typeof method === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(method) ? method : null
  } catch {
    return null
  }
}

/**
 * The method agy is signed in with: the Google sign-in its last answer's plan showed, since agy
 * names a plan only while signed in with Google; else Kettu's API key, which Kettu signs agy in
 * with; else the method its auth state file names, which only an ACP client's `authenticate`
 * writes. Null when none of them tells.
 */
export function antigravitySignIn(input: {
  answered: string | null
  file: string | null
  key: boolean
}): string | null {
  return input.answered ?? (input.key ? 'gemini-api-key' : input.file)
}
