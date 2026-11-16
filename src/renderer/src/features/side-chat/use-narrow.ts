import { useLayoutEffect, useState, type RefObject } from 'react'

// The thread keeps at least this width beside the column; below it the column goes over it.
const THREAD_MIN = 480
// The column's width, as `.kc-rail` sets it.
const RAIL_MIN = 280
const RAIL_MAX = 380
const RAIL_SHARE = 0.3

/** Whether the row is too narrow for the thread and the column side by side, while `on`. */
export function useNarrow(row: RefObject<HTMLElement | null>, on: boolean): boolean {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const element = row.current
    if (!element || !on) return
    const check = () => {
      const width = element.clientWidth
      const rail = Math.min(RAIL_MAX, Math.max(RAIL_MIN, width * RAIL_SHARE))
      setNarrow(width - rail < THREAD_MIN)
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(element)
    return () => observer.disconnect()
  }, [row, on])
  return on && narrow
}
