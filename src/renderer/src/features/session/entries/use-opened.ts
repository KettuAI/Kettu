import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolCallStatus } from '@renderer/components/affect/tool-call-card'

// Longer than an opening's entrance plays (session.css), so its class outlasts it.
const ENTRANCE_MS = 600

/**
 * Whether a folded card or run has opened since it mounted. Its content renders from then on and
 * stays, so a thread builds only the rows it shows and closing still animates. A card opens itself
 * when its call fails, without telling, so a failure counts as opening it. The third value is true
 * for a moment after someone opens it, while its content plays its entrance.
 */
export function useOpenedOnce(
  status?: ToolCallStatus,
  open = false,
): [boolean, (open: boolean) => void, boolean] {
  const [opened, setOpened] = useState(open)
  const [opening, setOpening] = useState(false)
  const [seen, setSeen] = useState(status)
  const timer = useRef<number | undefined>(undefined)
  if (status !== seen) {
    setSeen(status)
    if (status === 'error') setOpened(true)
  }
  const onOpenChange = useCallback((open: boolean) => {
    if (open) setOpened(true)
    window.clearTimeout(timer.current)
    setOpening(open)
    if (open) timer.current = window.setTimeout(() => setOpening(false), ENTRANCE_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return [opened, onOpenChange, opening]
}
