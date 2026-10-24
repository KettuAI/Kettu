import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { expiryOf, knownExpiry, type CachePhase, type KnownExpiry } from '@shared/prompt-cache'
import { useCachePhase } from '@renderer/features/prompt-cache/cache-phase'
import { useAgentsStore } from '@renderer/stores/agents'

/**
 * What a row shows of its session's prompt cache: `none` when the session has no request on
 * record, else its phase; null while it runs, for a subagent, and while the lifetime is not known.
 */
export type SessionCache = { state: 'none' } | { state: CachePhase; cache: KnownExpiry } | null

export function useSessionCache(summary: SessionSummary): SessionCache {
  const account = useAgentsStore((s) => s.byId[summary.agentId]?.account ?? null)
  const quiet =
    summary.origin === 'subagent' ||
    summary.status === 'running' ||
    summary.status === 'awaiting_permission'
  const cache = quiet
    ? null
    : knownExpiry(expiryOf(summary.agentId, summary.cache, summary.model, account))
  const phase = useCachePhase(cache)
  if (quiet) return null
  if (!summary.cache) return { state: 'none' }
  return cache && phase ? { state: phase, cache } : null
}

/** The cache is known to be gone, so the row's agent mark turns grey. */
export const cacheGone = (cache: SessionCache): boolean =>
  cache?.state === 'none' || cache?.state === 'expired'

/** How a row names a cache that is gone, at the end of its accessible name and in its tooltip. */
export function useGoneLabel(cache: SessionCache): string | null {
  const { t } = useTranslation('sidebar')
  if (cache?.state === 'none') return t('indicator.noCache')
  if (cache?.state !== 'expired') return null
  return t(cache.cache.estimate ? 'indicator.cacheLikelyExpired' : 'indicator.cacheExpired')
}
