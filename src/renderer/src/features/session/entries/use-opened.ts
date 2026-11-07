import { useCallback, useState } from 'react'
import type { ToolCallStatus } from '@renderer/components/affect/tool-call-card'

/**
 * Whether a folded card or run has opened since it mounted. Its content renders from then on and
 * stays, so a thread builds only the rows it shows and closing still animates. A card opens itself
 * when its call fails, without telling, so a failure counts as opening it.
 */
export function useOpenedOnce(status?: ToolCallStatus): [boolean, (open: boolean) => void] {
  const [opened, setOpened] = useState(false)
  const [seen, setSeen] = useState(status)
  if (status !== seen) {
    setSeen(status)
    if (status === 'error') setOpened(true)
  }
  const onOpenChange = useCallback((open: boolean) => {
    if (open) setOpened(true)
  }, [])
  return [opened, onOpenChange]
}
