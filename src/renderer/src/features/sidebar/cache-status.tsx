import { useTranslation } from 'react-i18next'
import type { KnownExpiry } from '@shared/prompt-cache'
import { useCacheLeft } from '@renderer/features/prompt-cache/cache-phase'
import { countdown } from '@renderer/lib/format'
import { useSeconds } from '@renderer/lib/use-now'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The status slot's ring in the cache's last minutes, named with the whole minutes left. */
export function CacheRing({ cache }: { cache: KnownExpiry }) {
  const { t } = useTranslation('sidebar')
  const minutes = useCacheLeft(cache.expiresAt, (left) => Math.floor(left / MINUTE)) ?? 0
  const label =
    minutes === 0
      ? t(cache.estimate ? 'indicator.cacheSoonAbout' : 'indicator.cacheSoon')
      : t(cache.estimate ? 'indicator.cacheExpiringAbout' : 'indicator.cacheExpiring', {
          count: minutes,
        })
  return (
    <span
      role="img"
      aria-label={label}
      className="size-2 rounded-full border-[1.5px] border-warning"
    />
  )
}

/** The row tooltip's line for a cache in its last minutes, to the second while it shows. */
export function CacheTip({ cache }: { cache: KnownExpiry }) {
  const { t } = useTranslation('sidebar')
  const now = useSeconds()
  const hours = cache.ttl % HOUR === 0
  const count = hours ? cache.ttl / HOUR : Math.round(cache.ttl / MINUTE)
  const lifetime = cache.estimate
    ? t(hours ? 'cache.estimateHours' : 'cache.estimateMinutes', { count })
    : t(hours ? 'cache.lastsHours' : 'cache.lastsMinutes', { count })
  return (
    <span className="tabular">
      {t(cache.estimate ? 'cache.expiresInAbout' : 'cache.expiresIn', {
        time: countdown(cache.expiresAt - now),
        lifetime,
      })}
    </span>
  )
}
