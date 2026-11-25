// What the usage page's charts share besides their tooltip: their size as laid out, the axis's
// steps, a bar with a rounded top, and the kinds of token in order with their colors.

import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { TokenPart } from './model'

/** An element's content box as laid out, updated as it resizes; zero until measured. */
export function useSize<T extends HTMLElement>(): [
  RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const width = element.clientWidth
      const height = element.clientHeight
      setSize((was) => (was.width === width && was.height === height ? was : { width, height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, size]
}

/** The rectangle of `x`, `y`, `width` and `height` inside an element, in the window's terms. */
export function rectIn(element: Element, x: number, y: number, width = 0, height = 0): DOMRect {
  const box = element.getBoundingClientRect()
  return new DOMRect(box.left + x, box.top + y, width, height)
}

/** A step for an axis that reaches `raw` in about one: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (raw <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(raw))
  const n = raw / power
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * power
}

/** A bar whose top corners are rounded by `r`, its foot square on the axis. */
export function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.max(0, Math.min(r, w / 2, h))
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`
}

/** The kinds of tokens in the order the composition lists them, the cache first. */
export const COMPOSITION: readonly TokenPart[] = [
  'cacheRead',
  'cacheWrite',
  'input',
  'output',
  'reasoning',
]
/** Each kind of token's color, the same in the figure and in the breakdown. */
export const PART_COLOR: Record<TokenPart, string> = {
  cacheRead: 'var(--part-cache-read)',
  cacheWrite: 'var(--part-cache-write)',
  input: 'var(--part-input)',
  output: 'var(--part-output)',
  reasoning: 'var(--part-reasoning)',
}
