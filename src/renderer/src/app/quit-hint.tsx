import { useEffect, useId, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { springs } from '@renderer/lib/motion'
import { useOverlayStore } from '@renderer/stores/overlays'
import { useQuitHintStore, type QuitHintShown } from '@renderer/stores/quit-hint'

/** The first Cmd+Q's hint in the middle of the window, its Q key running out with the time left. */
export function QuitHint() {
  const { t } = useTranslation('updates')
  const shown = useQuitHintStore((s) => s.shown)
  const id = useId()
  // It can cover the browser pane's native view, as a toast can.
  useEffect(() => {
    useOverlayStore.getState().set(id, shown !== null)
    return () => useOverlayStore.getState().set(id, false)
  }, [id, shown])
  return (
    <div role="status" className="pointer-events-none fixed inset-0 z-50 grid place-items-center">
      <AnimatePresence>
        {shown && (
          <motion.div
            key={shown.expiresAt}
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
            transition={springs.card}
            className="grid justify-items-center gap-2.5 rounded-2xl bg-hud px-6 pt-4.5 pb-3.5 shadow-hud backdrop-blur-xl backdrop-saturate-150"
          >
            <span className="sr-only">{t('quit.pressAgain')}</span>
            <span aria-hidden className="flex gap-1.5">
              <Key>⌘</Key>
              <Key countdown={shown}>Q</Key>
            </span>
            <span aria-hidden className="text-label font-medium text-hud-text">
              {t('quit.again')}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Key({ children, countdown }: { children: ReactNode; countdown?: QuitHintShown }) {
  return (
    <kbd className="relative isolate grid h-9.5 min-w-9.5 place-items-center overflow-hidden rounded-xl bg-hud-key px-2.5 font-sans text-lg font-medium text-hud-ink shadow-hud-key">
      {countdown && (
        <span
          className="absolute inset-0 -z-10 origin-right animate-run-out bg-hud-countdown motion-reduce:[animation-timing-function:step-end]"
          style={{
            animationDuration: `${countdown.duration}ms`,
            animationDelay: `${-countdown.elapsed}ms`,
          }}
        />
      )}
      {children}
    </kbd>
  )
}
