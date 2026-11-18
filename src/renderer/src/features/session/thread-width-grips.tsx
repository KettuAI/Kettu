import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import { MIN_WIDTH, setThreadWidth } from '@renderer/stores/thread-width'

// A key press changes the width this much, a Shift press four times as much.
const STEP = 48

interface Size {
  /** The content's width now. */
  width: number
  /** The most it can take: all the room the column has. */
  most: number
}

/** The content's width and the room for it, read from the box that lies where the column does. */
function useSize(outer: RefObject<HTMLDivElement | null>, box: RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState<Size | null>(null)
  useLayoutEffect(() => {
    const room = outer.current
    const column = box.current
    if (!room || !column) return
    const measure = (): void => {
      const style = getComputedStyle(column)
      const padding = (Number.parseFloat(style.paddingLeft) || 0) * 2
      const next = {
        width: Math.round(column.clientWidth - padding),
        most: Math.round(room.clientWidth - padding),
      }
      setSize((current) =>
        current && current.width === next.width && current.most === next.most ? current : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(room)
    observer.observe(column)
    return () => observer.disconnect()
  }, [outer, box])
  return size
}

/**
 * Handles on the thread's two side edges that widen or narrow the content, the composer under it
 * included: drag one and the edge follows the pointer while the other mirrors it, since the column
 * is centred. Double-click or Home gives the text size's width back.
 */
export function ThreadWidthGrips({ gutter }: { gutter: number }) {
  const outer = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const size = useSize(outer, box)
  return (
    // Leaves the width the thread's scrollbar takes, so the box lies where the column does.
    <div
      ref={outer}
      className="pointer-events-none absolute inset-y-0 left-0 z-5"
      style={{ right: gutter }}
    >
      <div ref={box} className="ks-thread__column relative mx-auto h-full w-full px-8">
        {size && size.most > MIN_WIDTH && (
          <>
            <Grip side="left" size={size} />
            <Grip side="right" size={size} />
          </>
        )}
      </div>
    </div>
  )
}

function Grip({ side, size }: { side: 'left' | 'right'; size: Size }) {
  const { t } = useTranslation('session')
  // Where a drag started: the pointer's x and the width then, with the room measured then.
  const drag = useRef<{ x: number; from: Size } | null>(null)
  const [dragging, setDragging] = useState(false)
  // The right edge moves with the pointer, the left against it.
  const sign = side === 'right' ? 1 : -1

  const setWidth = (wanted: number, most: number) => {
    setThreadWidth(Math.round(Math.min(most, Math.max(Math.min(MIN_WIDTH, most), wanted))))
  }
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, from: size }
    setDragging(true)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current) {
      setWidth(current.from.width + 2 * sign * (event.clientX - current.x), current.from.most)
    }
  }
  const up = () => {
    drag.current = null
    setDragging(false)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home') {
      setThreadWidth(null)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = (event.shiftKey ? 4 : 1) * STEP
    const outward = event.key === (side === 'right' ? 'ArrowRight' : 'ArrowLeft')
    setWidth(size.width + (outward ? step : -step), size.most)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('thread.width.label')}
      aria-valuenow={size.width}
      aria-valuemin={Math.min(MIN_WIDTH, size.most)}
      aria-valuemax={size.most}
      tabIndex={0}
      className="ks-width-grip"
      data-side={side}
      data-dragging={dragging || undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => setThreadWidth(null)}
      onKeyDown={keyDown}
    />
  )
}
