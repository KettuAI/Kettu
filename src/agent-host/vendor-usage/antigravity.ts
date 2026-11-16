// The plan Google Antigravity's ACP server 1.4.3 names in the `_meta` of its answers to
// `authenticate`, `session/new`, `session/load` and `session/resume` when signed in with Google:
// `{ antigravity: { tier: { name: 'Google AI Pro', id: 'g1-pro-tier', upgradeUri } } }`.

import { object } from './common'

/** The version the plan was checked on, as the server names it in `initialize`. */
export const ANTIGRAVITY_TIER_VERSION = '1.4.3'

/** The plan's name in an answer's `_meta`, or null when it names none. */
export function antigravityTier(meta: unknown): string | null {
  const tier = object(object(object(meta)?.antigravity)?.tier)
  const name = typeof tier?.name === 'string' ? tier.name.trim() : ''
  return name || null
}
