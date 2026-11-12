import { useEffect, useState } from 'react'
import { errorMessage, host } from '@renderer/lib/host'

const POLL_MS = 2_000

export interface TaskOutput {
  /** The end of the output, null until the first read. */
  text: string | null
  truncated: boolean
  /** Why the last read failed; the text of an earlier read stays. */
  error: string | null
}

const UNREAD: TaskOutput = { text: null, truncated: false, error: null }

/**
 * A background task's output while `enabled`: read at once, then every `every` ms while `live`
 * (2 s unless given), and once more when the task ends.
 */
export function useTaskOutput(
  sessionId: string,
  taskId: string,
  { enabled, live, every = POLL_MS }: { enabled: boolean; live: boolean; every?: number },
): TaskOutput {
  const [output, setOutput] = useState<TaskOutput>(UNREAD)

  useEffect(() => {
    if (!enabled) return
    let current = true
    let reading = false
    const read = () => {
      if (reading) return
      reading = true
      host('sessions.taskOutput', { sessionId, taskId })
        .then((result) => {
          if (!current) return
          setOutput((prev) =>
            prev.text === result.output && prev.truncated === result.truncated && !prev.error
              ? prev
              : { text: result.output, truncated: result.truncated, error: null },
          )
        })
        .catch((error: unknown) => {
          if (current) setOutput((prev) => ({ ...prev, error: errorMessage(error) }))
        })
        .finally(() => {
          reading = false
        })
    }
    read()
    const timer = live ? setInterval(read, every) : undefined
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [sessionId, taskId, enabled, live, every])

  return output
}
