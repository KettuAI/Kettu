import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { DraftAttachment } from '@renderer/stores/attachments'
import type { BoxText } from './use-prompt-box'

/**
 * The send key on a message that cannot go yet. While attachments are still being added it sends
 * once they are, unless the text or the attachments change first; for any other reason `refused`
 * says why, where the composer shows its errors, until that reason goes.
 */
export function useBlockedEnter({
  reason,
  waiting,
  source,
  attachments,
  send,
}: {
  /** Why the message cannot go now; null when it can. */
  reason: string | null
  /** The reason is only attachments still being added. */
  waiting: boolean
  source: BoxText
  attachments: readonly DraftAttachment[]
  send: () => void
}): { refused: string | null; enter: () => void } {
  const [refused, setRefused] = useState<string | null>(null)
  if (refused !== null && refused !== reason) setRefused(null)
  const adding = attachments.some((item) => item.status === 'adding')
  const keys = attachments.map((item) => item.key).join(' ')
  // The message Enter was pressed on, while it waits for its attachments.
  const armed = useRef<{ keys: string; text: string } | null>(null)
  const go = useEffectEvent(send)
  useEffect(
    () =>
      source.subscribe(() => {
        if (armed.current && armed.current.text !== source.text) armed.current = null
      }),
    [source],
  )
  useEffect(() => {
    if (armed.current === null) return
    if (armed.current.keys !== keys || armed.current.text !== source.text) armed.current = null
    else if (!adding) {
      armed.current = null
      go()
    }
  }, [keys, adding, source])
  const enter = () => {
    if (waiting) armed.current = { keys, text: source.text }
    else setRefused(reason)
  }
  return { refused, enter }
}
