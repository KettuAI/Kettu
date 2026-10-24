import { useTranslation } from 'react-i18next'
import { cachePhase, endingWindow, type CacheExpiry } from '@shared/prompt-cache'
import { Progress } from '@renderer/components/ui/progress'
import { countdown, longAgo, tokens } from '@renderer/lib/format'
import { useNow, useSeconds } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * The prompt cache's block in the top bar's cache card and the usage popover. `used` is the
 * context the next message reads again once the cache has expired.
 */
export function CacheDetails({
  cache,
  used,
  heading = false,
}: {
  cache: CacheExpiry
  used: number
  /** Titles the block, as the cache card does; the usage popover's has a title of its own. */
  heading?: boolean
}) {
  return cache.expiresAt === null || cache.ttl === null ? (
    <LastRequest at={cache.lastRequestAt} heading={heading} />
  ) : (
    <CacheCountdown
      lastRequestAt={cache.lastRequestAt}
      ttl={cache.ttl}
      expiresAt={cache.expiresAt}
      estimate={cache.estimate}
      used={used}
      heading={heading}
    />
  )
}

function Title({ heading }: { heading: boolean }) {
  const { t } = useTranslation('composer')
  return (
    <span className={heading ? 'text-ui font-medium' : 'text-muted-foreground'}>
      {t('usage.cache.title')}
    </span>
  )
}

/** For a cache whose lifetime nothing says: only how long ago the last request was. */
function LastRequest({ at, heading }: { at: number; heading: boolean }) {
  const { t } = useTranslation('composer')
  const now = useNow()
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {heading && <Title heading />}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground">{t('usage.cache.lastRequest')}</span>
        <span className="tabular">{longAgo(at, now)}</span>
      </div>
    </div>
  )
}

/** On a one-second clock, which runs only while the block shows, so it re-renders nothing else. */
function CacheCountdown({
  lastRequestAt,
  ttl,
  expiresAt,
  estimate,
  used,
  heading,
}: {
  lastRequestAt: number
  ttl: number
  expiresAt: number
  estimate: boolean
  used: number
  heading: boolean
}) {
  const { t } = useTranslation('composer')
  const now = useSeconds()
  const left = expiresAt - now
  const phase = cachePhase(expiresAt, endingWindow(ttl), now)
  const ago = longAgo(lastRequestAt, now)
  const hours = ttl % HOUR === 0
  const count = hours ? ttl / HOUR : Math.round(ttl / MINUTE)
  const lifetime = estimate
    ? t(hours ? 'usage.cache.estimateHours' : 'usage.cache.estimateMinutes', { count, ago })
    : t(hours ? 'usage.cache.lastsHours' : 'usage.cache.lastsMinutes', { count, ago })
  const read = { tokens: tokens(used) }
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <Title heading={heading} />
        <span className={cn('tabular', phase === 'ending' && 'text-warning')}>
          {phase === 'expired'
            ? t(estimate ? 'usage.cache.likelyExpired' : 'usage.cache.expired')
            : t(estimate ? 'usage.cache.expiresInAbout' : 'usage.cache.expiresIn', {
                time: countdown(left),
              })}
        </span>
      </div>
      {phase !== 'expired' && (
        <Progress
          value={Math.min(100, (left / ttl) * 100)}
          tone={phase === 'ending' ? 'attention' : 'default'}
          aria-label={t('usage.cache.left')}
        />
      )}
      <div className="flex flex-col gap-0.5">
        {phase !== 'expired' && <p className="text-muted-foreground">{lifetime}</p>}
        <p className="text-secondary">
          {phase !== 'expired'
            ? t('usage.cache.ifExpires', read)
            : t(estimate ? 'usage.cache.ifExpired' : 'usage.cache.costExpired', read)}
        </p>
      </div>
    </div>
  )
}
