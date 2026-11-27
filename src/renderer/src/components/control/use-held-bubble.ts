import { useCallback, useEffect, useRef, useState } from 'react'
import { HELD_BUBBLE_MS, type ControlPoint } from '@shared/control'

/** How long the bubble takes to leave. */
const LEAVE_MS = 200

export interface HeldBubbleState {
  id: number
  at: ControlPoint
  leaving: boolean
}

export interface HeldBubbleDismissTarget {
  contains(node: unknown): boolean
}

export interface HeldBubbleEventHost {
  addEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void
  removeEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void
}

/**
 * Dismisses a visible HeldBubble on outside pointerdown, Escape, or window blur while ignoring
 * clicks inside the bubble itself and the opening pointer event that spawned it.
 */
export function attachHeldBubbleDismiss({
  bubble,
  onDismiss,
  doc,
  win,
  deferArm = (arm) => queueMicrotask(arm),
}: {
  bubble: () => HeldBubbleDismissTarget | null
  onDismiss: () => void
  doc: HeldBubbleEventHost
  win?: HeldBubbleEventHost | null
  deferArm?: (arm: () => void) => void
}): () => void {
  let active = true
  let armed = false
  deferArm(() => {
    if (active) armed = true
  })

  const onPointerDown = (raw: unknown): void => {
    if (!armed) return
    const target = (raw as { target?: unknown } | null)?.target ?? null
    const element = bubble()
    if (element && target && element.contains(target)) return
    onDismiss()
  }

  const onKeyDown = (raw: unknown): void => {
    const event = raw as { key?: string; repeat?: boolean } | null
    if (!event || event.repeat || event.key !== 'Escape') return
    onDismiss()
  }

  const onBlur = (): void => {
    if (!armed) return
    onDismiss()
  }

  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('keydown', onKeyDown, true)
  win?.addEventListener('blur', onBlur)

  return () => {
    active = false
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('keydown', onKeyDown, true)
    win?.removeEventListener('blur', onBlur)
  }
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
  dismiss: () => void
  clear: () => void
} {
  const [bubble, setBubble] = useState<HeldBubbleState | null>(null)
  const [nudge, setNudge] = useState(0)
  const currentRef = useRef<HeldBubbleState | null>(null)
  const sequence = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const setCurrent = useCallback((next: HeldBubbleState | null) => {
    currentRef.current = next
    setBubble(next)
  }, [])

  const scheduleLeave = useCallback(
    (id: number) => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        if (currentRef.current?.id === id) setCurrent(null)
      }, LEAVE_MS)
    },
    [setCurrent],
  )

  const held = useCallback(
    (at: ControlPoint | null) => {
      setNudge((n) => n + 1)
      if (!at) return
      const id = ++sequence.current
      setCurrent({ id, at, leaving: false })
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        if (currentRef.current?.id !== id) return
        setCurrent({ ...currentRef.current, leaving: true })
        scheduleLeave(id)
      }, HELD_BUBBLE_MS)
    },
    [scheduleLeave, setCurrent],
  )

  const dismiss = useCallback(() => {
    const current = currentRef.current
    if (!current || current.leaving) return
    setCurrent({ ...current, leaving: true })
    scheduleLeave(current.id)
  }, [scheduleLeave, setCurrent])

  const clear = useCallback(() => {
    clearTimeout(timer.current)
    setCurrent(null)
  }, [setCurrent])

  useEffect(() => () => clearTimeout(timer.current), [])

  return { bubble, nudge, held, dismiss, clear }
}
