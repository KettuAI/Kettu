import { useState } from 'react'
import { errorMessage, host } from '@renderer/lib/host'

/** Stops one background task; `error` says why the last try failed. */
export function useStopTask(sessionId: string, taskId: string) {
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stop = () => {
    setStopping(true)
    setError(null)
    host('sessions.stopTask', { sessionId, taskId })
      .catch((reason: unknown) => setError(errorMessage(reason)))
      .finally(() => setStopping(false))
  }
  return { stop, stopping, error }
}
