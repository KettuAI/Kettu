import { useCallback, useEffect, useRef, useState } from 'react'
import { HELD_BUBBLE_MS, type ControlPoint } from '@shared/control'

/** How long the bubble takes to leave. */
const LEAVE_MS = 200

export interface HeldBubbleState {
  id: number
  at: ControlPoint
  leaving: boolean
}

/**
 * The input an agent's turn held back on a surface Kettu draws itself: each one bobs the pill, and
 * one with a point shows the bubble there for a moment. `held` takes the point in the pixels of
 * the box the bubble sits in, or null for a key.
 */
export function useHeldBubble(): {
  bubble: HeldBubbleState | null
  nudge: number
  held: (at: ControlPoint | null) => void
  clear: () => void
} {
  const [bubble, setBubble] = useState<HeldBubbleState | null>(null)
  const [nudge, setNudge] = useState(0)
  const sequence = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const held = useCallback((at: ControlPoint | null) => {
    setNudge((n) => n + 1)
    if (!at) return
    const id = ++sequence.current
    setBubble({ id, at, leaving: false })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setBubble((b) => (b?.id === id ? { ...b, leaving: true } : b))
      timer.current = setTimeout(() => setBubble((b) => (b?.id === id ? null : b)), LEAVE_MS)
    }, HELD_BUBBLE_MS)
  }, [])

  const clear = useCallback(() => {
    clearTimeout(timer.current)
    setBubble(null)
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  return { bubble, nudge, held, clear }
}
