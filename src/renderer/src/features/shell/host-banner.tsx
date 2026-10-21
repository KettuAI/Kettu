import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CircleAlertIcon, FileDownIcon, RotateCwIcon } from 'lucide-react'
import { exportDiagnostics } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { fadeExit } from '@renderer/lib/motion'
import { useConnectionStore } from '@renderer/stores/connection'

/**
 * The agent host's state while it is away: a small status pill centred over the top bar. It
 * floats instead of pushing the window down, so the macOS traffic lights never sit on it.
 */
export function HostBanner() {
  const state = useConnectionStore((s) => s.agentHost)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const restart = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.overbench.agents.restart()
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
    <div className="pointer-events-none absolute inset-x-0 top-[7px] z-50 flex justify-center">
      <AnimatePresence initial={false}>
        {state !== 'connected' && (
          <motion.div
            key={state}
            role="status"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2 } }}
            exit={fadeExit}
            className="app-region-no-drag pointer-events-auto flex h-[26px] items-center gap-1.5 rounded-full bg-popover pr-1 pl-3 text-xs text-muted-foreground shadow-menu"
          >
            {state === 'reconnecting' ? (
              <>
                <Spinner className="size-3" />
                <span className="pr-2">
                  Restarting the agent host. Your sessions come back by themselves.
                </span>
              </>
            ) : (
              <>
                <CircleAlertIcon className="size-3.5 text-destructive" />
                <span className={error ? 'text-destructive' : undefined}>
                  {error ?? 'The agent host stopped and could not be restarted.'}
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
                  Restart
                </Button>
                <Button variant="quiet" size="xs" className="rounded-full" onClick={save}>
                  <FileDownIcon data-icon="inline-start" />
                  Export diagnostics
                </Button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
