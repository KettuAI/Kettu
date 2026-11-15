// Sign-ins whose page the agent hands to the client: Mistral Vibe's `browser-auth-delegated`
// (3.0.1) and a URL elicitation tied to the `authenticate` request, as Factory Droid's
// `device-pairing` sends (0.251.0).

import { isWebUrl } from '../elicitation'

/** The method id, and the client capability in `_meta` that makes an agent offer it. */
export const DELEGATED_SIGN_IN = 'browser-auth-delegated'

/** The page and attempt `start` answers, from `_meta["browser-auth-delegated"]`; null otherwise. */
export function delegatedSignInStart(response: unknown): { url: string; attemptId: string } | null {
  if (typeof response !== 'object' || response === null) return null
  const meta = (response as { _meta?: unknown })._meta
  if (typeof meta !== 'object' || meta === null) return null
  const started = (meta as Record<string, unknown>)[DELEGATED_SIGN_IN]
  if (typeof started !== 'object' || started === null) return null
  const { signInUrl, attemptId } = started as { signInUrl?: unknown; attemptId?: unknown }
  if (typeof signInUrl !== 'string' || !isWebUrl(signInUrl)) return null
  if (typeof attemptId !== 'string' || attemptId === '') return null
  return { url: signInUrl, attemptId }
}

/**
 * A URL elicitation tied to a request rather than a session, with the request's JSON-RPC id as a
 * string and its page; null for any other elicitation, or a page that is not a web address.
 */
export function requestUrlElicitation(params: unknown): { requestId: string; url: string } | null {
  if (typeof params !== 'object' || params === null) return null
  const { mode, url, requestId, sessionId } = params as Record<string, unknown>
  if (mode !== 'url' || typeof url !== 'string' || !isWebUrl(url)) return null
  if (sessionId !== undefined && sessionId !== null) return null
  if (typeof requestId !== 'string' && typeof requestId !== 'number') return null
  return { requestId: String(requestId), url }
}
