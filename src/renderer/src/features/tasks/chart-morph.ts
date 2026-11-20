// Start on a suggestion card turns the session into the task in its place: the card's chart grows
// into the task page's flowchart. The card keeps where its chart was when Start was pressed; the
// page that opens for that task grows from there once.

import { useLayoutEffect, type RefObject } from 'react'
import { animate, useReducedMotionConfig } from 'motion/react'

const charts = new Map<string, HTMLElement>()
let held: { key: string; rect: DOMRect; at: number } | null = null
// A page that opens later than this after Start was pressed does not grow.
const FRESH_MS = 30_000
// --duration-morph and --ease-out-quart.
const MORPH = { duration: 0.3, ease: [0.165, 0.84, 0.44, 1] as const }

/** A card's chart as it is drawn, or gone. */
export function chartShown(cardId: string, element: HTMLElement | null): void {
  if (element) charts.set(cardId, element)
  else charts.delete(cardId)
}

/** Start was pressed on the card: its chart's place is kept. */
export function holdChart(cardId: string): void {
  const element = charts.get(cardId)
  held = element ? { key: cardId, rect: element.getBoundingClientRect(), at: Date.now() } : null
}

/** The card's task started and its page opens: the kept place is the page's. */
export function chartToTask(cardId: string, taskId: string): void {
  if (held?.key === cardId) held = { ...held, key: taskId }
}

/**
 * Grows the task page's flowchart from the card's chart, once, the first time it shows: when
 * `ready`, the page past its loading state.
 */
export function useChartMorph(
  taskId: string,
  target: RefObject<HTMLElement | null>,
  ready: boolean,
): void {
  const reduced = useReducedMotionConfig()
  useLayoutEffect(() => {
    const element = target.current
    if (!ready) return
    const from = held?.key === taskId && Date.now() - held.at < FRESH_MS ? held.rect : null
    if (!element || !from) return
    held = null
    if (reduced) return
    const to = element.getBoundingClientRect()
    if (to.width === 0 || to.height === 0) return
    const scale = Math.min(1, from.width / to.width)
    void animate(
      element,
      {
        x: [from.left - to.left, 0],
        y: [from.top - to.top, 0],
        scale: [scale, 1],
        opacity: [0.6, 1],
      },
      MORPH,
    )
  }, [taskId, target, reduced, ready])
}
