import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { cn } from '@renderer/lib/utils'

// Rows are --control-height tall, as the tree's rows, read once from the theme.
const ROW = parseFloat(
  getComputedStyle(document.documentElement).getPropertyValue('--control-height'),
)
const OVERSCAN = 8

/**
 * A key on a row of a list that is one Tab stop: the row to move to, or null to leave the key
 * alone. ArrowUp, ArrowDown, Home, End, PageUp and PageDown move without it.
 */
export type RowKey = (index: number, event: KeyboardEvent) => number | null

/** Scrolls the list just enough to show the row. */
function revealRow(el: HTMLElement, index: number, rowHeight: number): void {
  const style = getComputedStyle(el)
  const top = parseFloat(style.paddingTop) + index * rowHeight
  const bottom = top + rowHeight + parseFloat(style.paddingBottom)
  if (top < el.scrollTop) el.scrollTop = top
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
}

/**
 * A scrolling list of fixed-height rows that renders only those near the view, so a project of
 * tens of thousands of files scrolls like a short one. `scrollTo` brings a row into view. With
 * `roving`, the list is one Tab stop: `children` gets each row's `tabIndex`, and the arrow keys
 * move between rows.
 */
export function VirtualRows({
  count,
  scrollTo,
  rowHeight = ROW,
  className,
  initialScroll = 0,
  onScrollTop,
  roving = false,
  onRowKey,
  role,
  label,
  children,
}: {
  count: number
  scrollTo?: number | null
  /** Every row's height, when it is not the tree's. */
  rowHeight?: number
  className?: string
  /** Where the list starts scrolled to, as `onScrollTop` reported it before. */
  initialScroll?: number
  onScrollTop?: (top: number) => void
  roving?: boolean
  onRowKey?: RowKey
  role?: 'tree'
  label?: string
  children: (index: number, tabIndex: number | undefined) => ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const rowsBox = useRef<HTMLDivElement>(null)
  const [startTop] = useState(initialScroll)
  const [view, setView] = useState({ top: initialScroll, height: 0 })
  // The row that holds the list's Tab stop: the one shown with the open file, else the last used.
  const [active, setActive] = useState(scrollTo ?? 0)
  const [followed, setFollowed] = useState(scrollTo)
  if (scrollTo !== followed) {
    setFollowed(scrollTo)
    if (scrollTo !== null && scrollTo !== undefined) setActive(scrollTo)
  }
  // A row moved to by key, focused once the scroll has drawn it.
  const focusing = useRef<number | null>(null)
  const current = Math.min(active, Math.max(0, count - 1))

  useLayoutEffect(() => {
    if (box.current && startTop > 0) box.current.scrollTop = startTop
  }, [startTop])

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
    revealRow(el, scrollTo, rowHeight)
  }, [scrollTo, rowHeight])

  const first = Math.max(0, Math.floor(view.top / rowHeight) - OVERSCAN)
  const last = Math.min(count, Math.ceil((view.top + view.height) / rowHeight) + OVERSCAN)
  const rows: ReactNode[] = []
  for (let i = first; i < last; i++) {
    rows.push(children(i, roving ? (i === current ? 0 : -1) : undefined))
  }
  const drawn = current >= first && current < last

  const focusRow = (index: number): boolean => {
    if (index < first || index >= last) return false
    const row = rowsBox.current?.children[index - first]
    if (!(row instanceof HTMLElement)) return false
    row.focus()
    return true
  }

  useLayoutEffect(() => {
    const index = focusing.current
    if (index !== null && focusRow(index)) focusing.current = null
  })

  const moveTo = (index: number): void => {
    const next = Math.max(0, Math.min(count - 1, index))
    setActive(next)
    if (box.current) revealRow(box.current, next, rowHeight)
    if (!focusRow(next)) focusing.current = next
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!roving || count === 0 || event.altKey || event.metaKey || event.ctrlKey) return
    if (event.nativeEvent.isComposing) return
    const page = Math.max(1, Math.floor((box.current?.clientHeight ?? 0) / rowHeight) - 1)
    let next: number | null
    if (event.key === 'ArrowDown') next = current + 1
    else if (event.key === 'ArrowUp') next = current - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = count - 1
    else if (event.key === 'PageDown') next = current + page
    else if (event.key === 'PageUp') next = current - page
    else next = onRowKey?.(current, event) ?? null
    if (next === null) return
    event.preventDefault()
    moveTo(next)
  }

  return (
    <div
      ref={box}
      role={role}
      aria-label={label}
      // While its row is scrolled away, the list itself takes the Tab stop and hands it on.
      tabIndex={roving && !drawn && count > 0 ? 0 : undefined}
      className={cn('min-h-0 overflow-y-auto overscroll-contain', className)}
      onScroll={(event) => {
        const { scrollTop, clientHeight } = event.currentTarget
        setView({ top: scrollTop, height: clientHeight })
        onScrollTop?.(scrollTop)
      }}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (!roving) return
        if (event.target === event.currentTarget) {
          moveTo(current)
          return
        }
        // A row focused by a click takes the Tab stop.
        const at = rowsBox.current
          ? Array.prototype.indexOf.call(rowsBox.current.children, event.target)
          : -1
        if (at >= 0 && first + at !== current) setActive(first + at)
      }}
    >
      {/* Never shrunk by a flex list around it, so the list scrolls its whole length. */}
      <div className="relative shrink-0" style={{ height: count * rowHeight }}>
        <div
          ref={rowsBox}
          className="absolute inset-x-0 top-0"
          style={{ transform: `translateY(${first * rowHeight}px)` }}
        >
          {rows}
        </div>
      </div>
    </div>
  )
}
