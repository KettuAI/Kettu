// When a session's prompt cache expires: from the lifetime the agent's own transcript gives,
// else estimated from the shortest retention the agent's provider documents.

import type { AgentAccount } from './agent-host'
import type { AgentId, ConfigOption, PromptCache, SessionView } from './thread'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

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

/** A cache whose lifetime is known, so it has a moment it expires. */
export type KnownExpiry = CacheExpiry & { ttl: number; expiresAt: number }

export type CachePhase = 'warm' | 'ending' | 'expired'

/** The cache's last minutes, when the session page warns: five of an hour, one of less. */
export function endingWindow(ttl: number): number {
  return ttl >= HOUR ? 5 * MINUTE : MINUTE
}

/**
 * The provider whose retention applies. codex-acp reports a model provider other than OpenAI as a
 * gateway account, and Bedrock as an external one, so Codex is OpenAI only on a ChatGPT account
 * or an OpenAI API key. OpenCode names the provider in the model.
 */
function providerOf(
  agentId: AgentId,
  model: string | null,
  account: AgentAccount | null,
): string | null {
  if (agentId === 'codex') {
    return account?.kind === 'account' || account?.kind === 'api_key' ? 'openai' : null
  }
  if (agentId !== 'opencode' || model === null) return null
  const slash = model.indexOf('/')
  return slash > 0 ? model.slice(0, slash).toLowerCase() : null
}

/** `model` is the session's model option and `account` the one its agent last reported. */
export function expiryOf(
  agentId: AgentId,
  cache: PromptCache | null | undefined,
  model: string | null,
  account: AgentAccount | null,
): CacheExpiry | null {
  if (!cache) return null
  const { lastRequestAt, ttl } = cache
  if (ttl !== null) return { lastRequestAt, ttl, expiresAt: lastRequestAt + ttl, estimate: false }
  const provider = providerOf(agentId, model, account)
  const documented =
    provider !== null && Object.hasOwn(DOCUMENTED_TTL, provider) ? DOCUMENTED_TTL[provider]! : null
  if (documented === null) return { lastRequestAt, ttl: null, expiresAt: null, estimate: false }
  return { lastRequestAt, ttl: documented, expiresAt: lastRequestAt + documented, estimate: true }
}

/** The session's model option, as `expiryOf` takes it. */
export function modelOption(config: readonly ConfigOption[]): string | null {
  const model = config.find((option) => option.category === 'model')?.value
  return typeof model === 'string' ? model : null
}

export function cacheExpiry(
  session: Pick<SessionView, 'agentId' | 'config' | 'usage'>,
  account: AgentAccount | null,
): CacheExpiry | null {
  return expiryOf(session.agentId, session.usage?.cache, modelOption(session.config), account)
}

export function knownExpiry(expiry: CacheExpiry | null): KnownExpiry | null {
  if (!expiry || expiry.ttl === null || expiry.expiresAt === null) return null
  return { ...expiry, ttl: expiry.ttl, expiresAt: expiry.expiresAt }
}

/** `ending` is the cache's `endingWindow`. */
export function cachePhase(expiresAt: number, ending: number, now: number): CachePhase {
  if (now >= expiresAt) return 'expired'
  return expiresAt - now <= ending ? 'ending' : 'warm'
}

/** How long until the phase changes, or null once the cache has expired. */
export function nextPhaseIn(expiresAt: number, ending: number, now: number): number | null {
  const left = expiresAt - now
  if (left <= 0) return null
  return left > ending ? left - ending : left
}
