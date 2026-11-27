import { Cancel01Icon, Database02Icon, Timer02Icon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { CACHE_NOTICE_MIN_TOKENS, type PromptCacheDrop } from '@shared/prompt-cache'
import { Button } from '@renderer/components/ui/button'
import { tokens, usd } from '@renderer/lib/format'
import { fadeExit, glide } from '@renderer/lib/motion'
import { Glyph } from '@renderer/features/shell/glyph'

export { CACHE_NOTICE_MIN_TOKENS }

/**
 * The pop over the composer's top edge when a message is started on a prompt cache that has
 * expired: sending it reads the whole context again at full price.
 */
export function CacheNotice({
  estimate,
  used,
  onDismiss,
}: {
  /** The expiry is the provider's documented minimum, not the agent's own. */
  estimate: boolean
  /** The context the message reads again. */
  used: number
  onDismiss: () => void
}) {
  const { t } = useTranslation(['composer', 'common'])
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={fadeExit}
      transition={glide}
      className="kettu-cache-notice"
    >
      <Glyph icon={Timer02Icon} className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <b>{t(estimate ? 'usage.cache.noticeLikely' : 'usage.cache.notice')}</b>
        <p>
          {t(estimate ? 'usage.cache.ifExpired' : 'usage.cache.costExpired', {
            tokens: tokens(used),
          })}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common:actions.dismiss')}
        onClick={onDismiss}
      >
        <Glyph icon={Cancel01Icon} />
      </Button>
    </motion.div>
  )
}

/**
 * Opt-in post-turn pop over the composer's top edge when measured prompt cache hits drop sharply
 * compared to the prior comparable turn. Reuses the existing cache-notice styling and only shows
 * verifiable reasons and extra cost when backed by observed facts or confirmed model pricing.
 */
export function CacheDropNotice({
  drop,
  onDismiss,
}: {
  drop: PromptCacheDrop
  onDismiss: () => void
}) {
  const { t } = useTranslation(['composer', 'common'])
  const before = Math.round(drop.baselineShare * 100)
  const after = Math.round(drop.currentShare * 100)
  const details: string[] = []
  if (drop.reason !== null) {
    details.push(t(`usage.cache.dropNotice.reasons.${drop.reason}`))
  }
  if (drop.extraCostUsd !== null) {
    details.push(t('usage.cache.dropNotice.extraCost', { cost: usd(drop.extraCostUsd) }))
  }
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={fadeExit}
      transition={glide}
      className="kettu-cache-notice"
    >
      <Glyph
        icon={drop.reason === 'expired' ? Timer02Icon : Database02Icon}
        className="mt-0.5 size-4 shrink-0 text-warning"
      />
      <div className="min-w-0 flex-1">
        <b>{t('usage.cache.dropNotice.title')}</b>
        <p className="tabular">
          {t('usage.cache.dropNotice.change', {
            before,
            after,
            cached: tokens(drop.currentCacheRead),
            total: tokens(drop.currentTotalInput),
          })}
        </p>
        {details.length > 0 && <p className="mt-0.5 tabular">{details.join(' · ')}</p>}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common:actions.dismiss')}
        onClick={onDismiss}
      >
        <Glyph icon={Cancel01Icon} />
      </Button>
    </motion.div>
  )
}
