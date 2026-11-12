import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { DraftAttachment } from '@renderer/stores/attachments'

/**
 * The send key on a message that cannot go yet. While attachments are still being added it sends
 * once they are, unless the text or the attachments change first; for any other reason `refused`
 * says why, where the composer shows its errors, until that reason goes.
 */
export function useBlockedEnter({
  reason,
  waiting,
  text,
  attachments,
  send,
}: {
  /** Why the message cannot go now; null when it can. */
  reason: string | null
  /** The reason is only attachments still being added. */
  waiting: boolean
  text: string
  attachments: readonly DraftAttachment[]
  send: () => void
}): { refused: string | null; enter: () => void } {
  const [refused, setRefused] = useState<string | null>(null)
  if (refused !== null && refused !== reason) setRefused(null)
  const adding = attachments.some((item) => item.status === 'adding')
  const shape = `${attachments.map((item) => item.key).join(' ')}\n${text}`
  // The shape of the message Enter was pressed on, while it waits for its attachments.
  const armed = useRef<string | null>(null)
  const go = useEffectEvent(send)
  useEffect(() => {
    if (armed.current === null) return
    if (armed.current !== shape) armed.current = null
    else if (!adding) {
      armed.current = null
      go()
    }
  }, [shape, adding])
  const enter = () => {
    if (waiting) armed.current = shape
    else setRefused(reason)
  }
  return { refused, enter }
}
