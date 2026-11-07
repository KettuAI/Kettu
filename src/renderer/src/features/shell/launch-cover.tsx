import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { BrandFox } from '@renderer/components/brand'
import { useProjectsStore } from '@renderer/stores/projects'
import { useViewStore } from '@renderer/stores/view'

// --duration-slow and --ease-out-quart.
const SLOW = 0.3
const EASE = [0.165, 0.84, 0.44, 1] as const

/**
 * Hides the whole window until launch knows what to show: the flat fox breathing on the window's
 * background, fading out over the shell laid out beneath. A failed load lifts it for the main
 * area's Retry.
 */
export function LaunchCover() {
  const { t } = useTranslation('shell')
  const launching = useViewStore((s) => s.main.kind === 'launch')
  const failed = useProjectsStore((s) => s.error !== null)
  return (
    <AnimatePresence>
      {launching && !failed && (
        <motion.div
          key="launch-cover"
          role="status"
          exit={{ opacity: 0 }}
          transition={{ duration: SLOW, ease: EASE }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-sidebar pb-10 app-region-drag"
        >
          {/* The icon's fox drawn flat in its cool white, in the tones for the theme's ground. */}
          <BrandFox className="size-14 animate-breathe" />
          <span className="sr-only">{t('launch.starting')}</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
