import { AnimatePresence, motion } from 'motion/react'
import { CircleAlertIcon } from 'lucide-react'
import { Spinner } from '@renderer/components/ui/spinner'
import { fadeExit } from '@renderer/lib/motion'
import { useConnectionStore } from '@renderer/stores/connection'

/** A thin banner at the top of the window while the agent host restarts. */
export function HostBanner() {
  const state = useConnectionStore((s) => s.agentHost)
  return (
    <AnimatePresence initial={false}>
      {state !== 'connected' && (
        <motion.div
          key={state}
          role="status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.2 } }}
          exit={fadeExit}
          className="flex h-[26px] shrink-0 items-center justify-center gap-1.5 bg-muted text-xs text-muted-foreground"
        >
          {state === 'reconnecting' ? (
            <>
              <Spinner className="size-3" />
              Restarting the agent host. Your sessions will come back by themselves.
            </>
          ) : (
            <>
              <CircleAlertIcon className="size-3.5 text-destructive" />
              The agent host stopped and could not be restarted.
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
