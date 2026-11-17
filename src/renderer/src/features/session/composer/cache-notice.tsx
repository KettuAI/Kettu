import { Cancel01Icon, Timer02Icon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { tokens } from '@renderer/lib/format'
import { fadeExit, glide } from '@renderer/lib/motion'
import { Glyph } from '@renderer/features/shell/glyph'

/** Below this many tokens read again, an expired cache costs too little to warn about. */
export const CACHE_NOTICE_MIN_TOKENS = 20_000

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
