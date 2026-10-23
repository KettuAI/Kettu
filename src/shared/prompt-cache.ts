// When a session's prompt cache expires: from the lifetime the agent's own transcript gives,
// else estimated from the shortest retention the agent's provider documents.

import type { AgentAccount } from './agent-host'
import type { AgentId, ConfigOption, SessionView } from './thread'

const MINUTE = 60_000

/** From this much time left, the usage ring shows that the cache is about to expire. */
export const CACHE_ENDING_MS = MINUTE

/**
 * The shortest time each provider documents keeping a prompt cache after its last use, checked on
 * 2026-10-23: OpenAI keeps a prefix for 5 to 10 minutes of inactivity, Anthropic for 5 minutes
 * unless a request asks for an hour.
 */
const DOCUMENTED_TTL: Readonly<Record<string, number>> = {
  openai: 5 * MINUTE,
  anthropic: 5 * MINUTE,
}

export interface CacheExpiry {
  lastRequestAt: number
  /** How long the cache lasts after a request, or null when nothing says. */
  ttl: number | null
  expiresAt: number | null
  /** The lifetime is the provider's documented minimum, not the agent's own. */
  estimate: boolean
}

export type CachePhase = 'warm' | 'ending' | 'expired'

/**
 * The provider whose retention applies. codex-acp reports a model provider other than OpenAI as a
 * gateway account, and Bedrock as an external one, so Codex is OpenAI only on a ChatGPT account
 * or an OpenAI API key. OpenCode names the provider in the model.
 */
function providerOf(
  agentId: AgentId,
  config: readonly ConfigOption[],
  account: AgentAccount | null,
): string | null {
  if (agentId === 'codex') {
    return account?.kind === 'account' || account?.kind === 'api_key' ? 'openai' : null
  }
  if (agentId !== 'opencode') return null
  const model = config.find((option) => option.category === 'model')?.value
  if (typeof model !== 'string') return null
  const slash = model.indexOf('/')
  return slash > 0 ? model.slice(0, slash).toLowerCase() : null
}

/** `account` is the one the session's agent last reported. */
export function cacheExpiry(
  session: Pick<SessionView, 'agentId' | 'config' | 'usage'>,
  account: AgentAccount | null,
): CacheExpiry | null {
  const cache = session.usage?.cache
  if (!cache) return null
  const { lastRequestAt, ttl } = cache
  if (ttl !== null) return { lastRequestAt, ttl, expiresAt: lastRequestAt + ttl, estimate: false }
  const provider = providerOf(session.agentId, session.config, account)
  const documented =
    provider !== null && Object.hasOwn(DOCUMENTED_TTL, provider) ? DOCUMENTED_TTL[provider]! : null
  if (documented === null) return { lastRequestAt, ttl: null, expiresAt: null, estimate: false }
  return { lastRequestAt, ttl: documented, expiresAt: lastRequestAt + documented, estimate: true }
}

export function cachePhase(expiresAt: number, now: number): CachePhase {
  if (now >= expiresAt) return 'expired'
  return expiresAt - now <= CACHE_ENDING_MS ? 'ending' : 'warm'
}

/** How long until the phase changes, or null once the cache has expired. */
export function nextPhaseIn(expiresAt: number, now: number): number | null {
  const left = expiresAt - now
  if (left <= 0) return null
  return left > CACHE_ENDING_MS ? left - CACHE_ENDING_MS : left
}
