import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  dragThreadWidth,
  MIN_WIDTH,
  resetThreadWidth,
  setThreadWidth,
  stepThreadWidth,
} from '@renderer/stores/thread-width'

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
 * is centred. Double-click or Home resets to the selected conversation width preset.
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
            <WidthGrip side="left" size={size} />
            <WidthGrip side="right" size={size} />
          </>
        )}
      </div>
    </div>
  )
}

export function WidthGrip({ side, size }: { side: 'left' | 'right'; size: Size }) {
  const { t } = useTranslation('session')
  const preset = useSettingsStore((s) => s.settings.appearance.conversationWidth)
  // Where a drag started: the pointer's x and the width then, with the room measured then.
  const drag = useRef<{ x: number; from: Size } | null>(null)
  const [dragging, setDragging] = useState(false)

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, from: size }
    setDragging(true)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current) {
      setThreadWidth(
        dragThreadWidth(current.from.width, current.from.most, side, event.clientX - current.x),
      )
    }
  }
  const up = () => {
    drag.current = null
    setDragging(false)
  }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = stepThreadWidth(size.width, size.most, side, event.key, event.shiftKey)
    if (next === undefined) return
    if (next === null) {
      resetThreadWidth()
      return
    }
    event.preventDefault()
    setThreadWidth(next)
  }

  const hint = t('thread.width.hint', { preset: t(`thread.width.presets.${preset}`) })

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('thread.width.label')}
      title={hint}
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
      onDoubleClick={resetThreadWidth}
      onKeyDown={keyDown}
    />
  )
}
