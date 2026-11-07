import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { fadeExit } from '@renderer/lib/motion'
import { useReportStore } from '@renderer/stores/report'

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** While steps are being recorded: how long so far, and Stop and report. */
export function RecordingPill() {
  const { t } = useTranslation('report')
  const recording = useReportStore((s) => s.recording)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [recording])
  return (
    <AnimatePresence initial={false}>
      {recording && (
        <motion.div
          key="recording"
          role="status"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.2 } }}
          exit={fadeExit}
          className="app-region-no-drag pointer-events-auto flex h-[26px] items-center gap-1.5 rounded-full bg-popover pr-1 pl-3 text-xs text-secondary shadow-menu"
        >
          <span aria-hidden className="size-2 rounded-full bg-danger" />
          <span>{t('recording.label')}</span>
          <span className="tabular text-tertiary">{elapsed(now - recording.startedAt)}</span>
          <Button
            variant="quiet"
            size="xs"
            className="rounded-full"
            onClick={() => void window.kettu.report.record(false)}
          >
            {t('recording.stop')}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
