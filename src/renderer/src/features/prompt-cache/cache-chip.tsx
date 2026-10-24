import { useTranslation } from 'react-i18next'
import { cacheExpiry, knownExpiry } from '@shared/prompt-cache'
import type { SessionView } from '@shared/thread'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { timeLeft } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { CacheDetails } from './cache-details'
import { CacheHourglass } from './cache-hourglass'
import { useCacheLeft, useCachePhase } from './cache-phase'

/**
 * The top bar's chip with the time the session's prompt cache has left, between turns and while
 * its lifetime is known; a click opens the cache card.
 */
export function CacheChip({ session }: { session: SessionView }) {
  const { t } = useTranslation('composer')
  const account = useAgentsStore((s) => s.byId[session.agentId]?.account ?? null)
  // A turn's requests keep the cache in use.
  const running = session.status === 'running' || session.status === 'awaiting_permission'
  const cache = knownExpiry(running ? null : cacheExpiry(session, account))
  const phase = useCachePhase(cache)
  const time = useCacheLeft(cache?.expiresAt ?? null, timeLeft)
  if (!cache || !phase || !session.usage) return null
  const label =
    phase === 'expired'
      ? t(cache.estimate ? 'usage.cache.chipLikelyExpired' : 'usage.cache.chipExpired')
      : t(cache.estimate ? 'usage.cache.chipAbout' : 'usage.cache.chip', { time })
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              'ml-1 inline-flex h-6 shrink-0 animate-in items-center gap-1 rounded-md bg-subtle px-2 text-xs text-tertiary tabular outline-none fade-in transition-colors duration-(--duration-fast) hover:bg-hover hover:text-secondary focus-ring data-popup-open:bg-hover',
              phase === 'ending' && 'text-warning hover:text-warning',
            )}
          />
        }
      >
        <CacheHourglass expiresAt={cache.expiresAt} ttl={cache.ttl} className="size-3" />
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[320px] gap-0 px-3.5 pt-3 pb-3">
        <CacheDetails cache={cache} used={session.usage.used} heading />
      </PopoverContent>
    </Popover>
  )
}
