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

/** Where a chart is drawn on screen, in px. */
export interface ChartRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Grows the task page's flowchart from the card's chart, once, the first time it shows: `target`
 * moves and scales from its top left so the chart drawn in it, at `chart()` once `ready`, starts
 * where the card's was, its left edge and middle on the card's.
 */
export function useChartMorph(
  taskId: string,
  target: RefObject<HTMLElement | null>,
  ready: boolean,
  chart: () => ChartRect | null,
): void {
  const reduced = useReducedMotionConfig()
  useLayoutEffect(() => {
    const element = target.current
    if (!ready) return
    const from = held?.key === taskId && Date.now() - held.at < FRESH_MS ? held.rect : null
    if (!element || !from) return
    held = null
    const to = chart()
    if (reduced || !to || to.width === 0 || to.height === 0) return
    const box = element.getBoundingClientRect()
    const scale = Math.min(1, from.width / to.width)
    void animate(
      element,
      {
        x: [from.left - box.left - scale * (to.left - box.left), 0],
        y: [from.top + from.height / 2 - box.top - scale * (to.top + to.height / 2 - box.top), 0],
        scale: [scale, 1],
        opacity: [0.6, 1],
      },
      MORPH,
    )
    // The chart's place is read once, when it first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, target, reduced, ready])
}
