import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CircleAlertIcon, FileDownIcon, RotateCwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { exportDiagnostics } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { fadeExit } from '@renderer/lib/motion'
import { hasBand } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useConnectionStore } from '@renderer/stores/connection'

/**
 * The agent host's state while it is away: a small status pill centred over the top bar, or on
 * Windows and Linux in the band above it. It floats instead of pushing the window down, so the
 * macOS traffic lights never sit on it.
 */
export function HostBanner() {
  const { t } = useTranslation('shell')
  const state = useConnectionStore((s) => s.agentHost)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const restart = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.kettu.agents.restart()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    setError(null)
    exportDiagnostics().catch((e: unknown) => setError(errorMessage(e)))
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 z-50 flex justify-center',
        hasBand ? 'top-[calc((var(--title-bar)-26px)/2)]' : 'top-[calc((var(--top-bar)-26px)/2)]',
      )}
    >
      <AnimatePresence initial={false}>
        {state !== 'connected' && (
          <motion.div
            key={state}
            role="status"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2 } }}
            exit={fadeExit}
            className="app-region-no-drag pointer-events-auto flex h-[26px] items-center gap-1.5 rounded-full bg-popover pr-1 pl-3 text-xs text-secondary shadow-menu"
          >
            {state === 'reconnecting' || state === 'resuming' ? (
              <>
                <Spinner className="size-3" />
                <span className="pr-2">
                  {t(state === 'resuming' ? 'hostBanner.reconnecting' : 'hostBanner.restarting')}
                </span>
              </>
            ) : (
              <>
                <CircleAlertIcon className="size-3.5 text-danger" />
                <span className={error ? 'text-danger' : undefined}>
                  {error ?? t('hostBanner.stopped')}
                </span>
                <Button
                  variant="quiet"
                  size="xs"
                  className="rounded-full"
                  disabled={busy}
                  onClick={() => void restart()}
                >
                  {busy ? (
                    <Spinner data-icon="inline-start" className="size-3" />
                  ) : (
                    <RotateCwIcon data-icon="inline-start" />
                  )}
                  {t('hostBanner.restart')}
                </Button>
                <Button variant="quiet" size="xs" className="rounded-full" onClick={save}>
                  <FileDownIcon data-icon="inline-start" />
                  {t('hostBanner.exportDiagnostics')}
                </Button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
