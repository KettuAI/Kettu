import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@renderer/lib/utils'

// Rows are --control-height tall, as the tree's rows, read once from the theme.
const ROW = parseFloat(
  getComputedStyle(document.documentElement).getPropertyValue('--control-height'),
)
const OVERSCAN = 8

/**
 * A scrolling list of fixed-height rows that renders only those near the view, so a project of
 * tens of thousands of files scrolls like a short one. `scrollTo` brings a row into view.
 */
export function VirtualRows({
  count,
  scrollTo,
  rowHeight = ROW,
  className,
  children,
}: {
  count: number
  scrollTo?: number | null
  /** Every row's height, when it is not the tree's. */
  rowHeight?: number
  className?: string
  children: (index: number) => ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 0 })

  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(() =>
      setView({ top: el.scrollTop, height: el.clientHeight }),
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const el = box.current
    if (!el || scrollTo === null || scrollTo === undefined) return
    const style = getComputedStyle(el)
    const top = parseFloat(style.paddingTop) + scrollTo * rowHeight
    const bottom = top + rowHeight + parseFloat(style.paddingBottom)
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }, [scrollTo, rowHeight])

  const first = Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN)
  const last = Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN)
  const rows: ReactNode[] = []
  for (let i = first; i < last; i++) rows.push(children(i))

  return (
    <div
      ref={box}
      className={cn('min-h-0 overflow-y-auto overscroll-contain', className)}
      onScroll={(event) =>
        setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
      }
    >
      <div className="relative" style={{ height: count * rowHeight }}>
        <div
          className="absolute inset-x-0 top-0"
          style={{ transform: `translateY(${first * rowHeight}px)` }}
        >
          {rows}
        </div>
      </div>
    </div>
  )
}
