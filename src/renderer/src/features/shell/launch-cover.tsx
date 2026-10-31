import { AnimatePresence, motion } from 'motion/react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import onDarkUrl from '@renderer/assets/kettu-glyph-on-dark.svg'
import onLightUrl from '@renderer/assets/kettu-glyph-on-light.svg'
import { useProjectsStore } from '@renderer/stores/projects'
import { useViewStore } from '@renderer/stores/view'

// --duration-slow and --ease-out-quart.
const SLOW = 0.3
const EASE = [0.165, 0.84, 0.44, 1] as const

/**
 * Hides the whole window until launch knows what to show: the fox breathing on the window's own
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
          {/* The glyph keeps the drawing's light on either ground, shaded for the theme's mode. */}
          <span
            aria-hidden
            className="size-14 animate-breathe bg-current opacity-90 mask-contain mask-center mask-no-repeat text-primary [mask-image:var(--glyph-on-light)] dark:[mask-image:var(--glyph-on-dark)]"
            style={
              {
                '--glyph-on-light': `url(${onLightUrl})`,
                '--glyph-on-dark': `url(${onDarkUrl})`,
              } as CSSProperties
            }
          />
          <span className="sr-only">{t('launch.starting')}</span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
