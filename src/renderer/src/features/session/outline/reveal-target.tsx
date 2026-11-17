import { useEffect, useRef, type RefObject } from 'react'
import { REVEAL_TTL_MS, useRevealStore } from '@renderer/stores/reveal'
import { useThreadsStore } from '@renderer/stores/threads'
import type { ThreadJumps } from '../thread'
import { useJumpToMessage } from './use-jump'

// How long the message Search went to stays marked.
const FOUND_MS = 1800

/**
 * Takes the thread to the message Search opened this session for, once the thread holds its
 * latest page, and marks the message for a moment. Inside the message scroller.
 */
export function RevealTarget({
  sessionId,
  viewport,
  content,
  jumps,
}: {
  sessionId: string
  viewport: RefObject<HTMLDivElement | null>
  content: RefObject<HTMLDivElement | null>
  jumps: ThreadJumps
}) {
  const target = useRevealStore((s) => (s.target?.sessionId === sessionId ? s.target : null))
  const loaded = useThreadsStore((s) => Boolean(s.replicas[sessionId]?.state))
  const { jumpTo } = useJumpToMessage(sessionId, viewport, content, jumps)
  const jump = useRef(jumpTo)
  useEffect(() => {
    jump.current = jumpTo
  })

  useEffect(() => {
    if (!target || !loaded) return
    useRevealStore.setState({ target: null })
    if (Date.now() - target.at > REVEAL_TTL_MS) return
    void jump
      .current({ entryId: target.entryId, pos: target.pos }, { instant: true })
      .then((arrived) => {
        const message = arrived
          ? content.current?.querySelector<HTMLElement>(
              `[data-message-id="${CSS.escape(target.entryId)}"]`,
            )
          : null
        if (!message) return
        message.dataset.found = ''
        setTimeout(() => {
          delete message.dataset.found
        }, FOUND_MS)
      })
  }, [target, loaded, content])

  return null
}
