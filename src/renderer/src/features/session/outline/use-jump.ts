import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useMessageScroller } from '@renderer/components/ui/message-scroller'
import { prefersReducedMotion } from '@renderer/stores/settings'
import { loadThrough, useThreadsStore } from '@renderer/stores/threads'
import type { ThreadJumps } from '../thread'

// A jump shows its spinner only when it waits this long for its pages.
const SPINNER_AFTER_MS = 200
// How many times a jump's scroll is set right before it is left as it is.
const SETTLE_PASSES = 3
// A scroll that sends no scrollend, as one already in place, is taken as ended after this.
const SCROLL_END_MS = 1500

const scrollEnd = (view: HTMLElement): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      view.removeEventListener('scrollend', done)
      resolve()
    }
    const timer = setTimeout(done, SCROLL_END_MS)
    view.addEventListener('scrollend', done)
  })

/** The message a jump goes to; `pos` is null for one the host has not listed yet. */
export interface JumpTarget {
  entryId: string
  pos: number | null
}

export interface JumpOptions {
  /** Called once the target is rendered, before the scroll to it settles. */
  onRevealed?: () => void
  /** Scrolls at once instead of smoothly, as for a thread just opened. */
  instant?: boolean
}

/**
 * Jumps in a thread to one of its messages: loads the pages back to it, renders it and scrolls it
 * to the top, setting the scroll right again as the items above it take their real height. A
 * newer jump, or the reader's own scroll, ends the one under way. Inside the message scroller.
 */
export function useJumpToMessage(
  sessionId: string,
  viewport: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  jumps: ThreadJumps,
): {
  /** Resolves with whether the message arrived in its place. */
  jumpTo: (target: JumpTarget, options?: JumpOptions) => Promise<boolean>
  /** The message whose pages a jump has waited for long enough to say so. */
  waiting: string | null
} {
  const { scrollToMessage } = useMessageScroller()
  const [waiting, setWaiting] = useState<string | null>(null)
  const jumping = useRef(0)
  useEffect(
    () => () => {
      jumping.current++
    },
    [],
  )

  /**
   * Scrolls the target to its place and keeps it there: items above it keep an estimated height
   * until they render, so a long smooth scroll can land off, and is set right once it ends. A
   * scroll of the reader's own ends it.
   */
  const settle = useCallback(
    async (
      view: HTMLElement,
      column: HTMLElement,
      target: string,
      instant: boolean,
      current: () => boolean,
    ): Promise<boolean> => {
      // An item's own top spacing keeps the message under the top fade.
      const place = (behavior: ScrollBehavior): void => {
        scrollToMessage(target, { align: 'start', behavior })
      }
      const off = (): boolean => {
        const element = column.querySelector(`[data-message-id="${CSS.escape(target)}"]`)
        if (!element) return false
        const inset = Number.parseFloat(getComputedStyle(column).paddingTop) || 0
        const top = element.getBoundingClientRect().top - view.getBoundingClientRect().top
        return Math.abs(top - inset) > 1
      }
      let reader = false
      const intent = (): void => {
        reader = true
      }
      const events = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const
      for (const name of events) view.addEventListener(name, intent, { passive: true })
      try {
        place(instant || prefersReducedMotion() ? 'auto' : 'smooth')
        for (let pass = 0; pass < SETTLE_PASSES && off(); pass++) {
          await scrollEnd(view)
          if (reader || !current()) return false
          if (off()) place('auto')
        }
        return !reader && current()
      } finally {
        for (const name of events) view.removeEventListener(name, intent)
      }
    },
    [scrollToMessage],
  )

  const jumpTo = useCallback(
    async (target: JumpTarget, options: JumpOptions = {}): Promise<boolean> => {
      const view = viewport.current
      const column = content.current
      if (!view || !column) return false
      const id = ++jumping.current
      const current = (): boolean => jumping.current === id
      const timer = setTimeout(() => {
        if (current()) setWaiting(target.entryId)
      }, SPINNER_AFTER_MS)
      try {
        const hasEntry = (): boolean =>
          useThreadsStore.getState().replicas[sessionId]?.state?.byId[target.entryId] !== undefined
        if (!hasEntry()) {
          if (!(await loadThrough(sessionId, target.pos ?? 0))) return false
          if (!current()) return false
          if (!hasEntry()) {
            const after = useThreadsStore.getState().replicas[sessionId]
            if (after?.older !== null && after?.older !== undefined && (target.pos ?? 0) > 0) {
              if (!(await loadThrough(sessionId, 0))) return false
              if (!current()) return false
            }
          }
        }
        if (!hasEntry()) return false
        await jumps.reveal(target.entryId)
      } finally {
        clearTimeout(timer)
        if (current()) setWaiting(null)
      }
      if (!current()) return false
      options.onRevealed?.()
      jumps.hold(true)
      try {
        return await settle(view, column, target.entryId, options.instant ?? false, current)
      } finally {
        if (current()) jumps.hold(false)
      }
    },
    [sessionId, viewport, content, jumps, settle],
  )

  return { jumpTo, waiting }
}
