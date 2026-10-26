import { HourglassIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cacheChipState, cacheExpiry } from '@shared/prompt-cache'
import type { SessionView } from '@shared/thread'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { timeLeft } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { useAgentsStore } from '@renderer/stores/agents'
import { CacheDetails } from './cache-details'
import { CacheHourglass } from './cache-hourglass'
import { useCacheLeft, useCachePhase } from './cache-phase'

const CHIP =
  'ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-subtle px-2 text-xs text-tertiary tabular'

/**
 * The top bar's chip: the time the session's prompt cache has left, between turns, which a click
 * opens; or a hint that the model reports no cache time, so there is none to show.
 */
export function CacheChip({ session }: { session: SessionView }) {
  const { t } = useTranslation('composer')
  const account = useAgentsStore((s) => s.byId[session.agentId]?.account ?? null)
  // A turn's requests keep the cache in use.
  const running = session.status === 'running' || session.status === 'awaiting_permission'
  const state = cacheChipState(running ? null : cacheExpiry(session, account))
  const known = state?.kind === 'countdown' ? state.expiry : null
  const phase = useCachePhase(known)
  const time = useCacheLeft(known?.expiresAt ?? null, timeLeft)
  if (!state || !session.usage) return null
  if (state.kind === 'unknown') {
    return (
      <span className={CHIP}>
        <HourglassIcon aria-hidden className="size-3" />
        {t('usage.cache.chipNotReported')}
      </span>
    )
  }
  const cache = state.expiry
  if (!phase) return null
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
              CHIP,
              'animate-in outline-none fade-in transition-colors duration-(--duration-fast) hover:bg-hover hover:text-secondary focus-ring data-popup-open:bg-hover',
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
