import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { motion, useDragControls, useMotionValue } from 'motion/react'
import { cn } from '@renderer/lib/utils'
import { setSurfacePill, useSurfacePill, type PillKind } from '@renderer/stores/surface-pill'

const share = (offset: number, free: number) =>
  free > 0 ? Math.min(1, Math.max(0, offset / free)) : 0.5

/**
 * Where a surface's pill lies: at the bottom, centred, until the user drags it by anything but its
 * buttons; then where they put it, kept for every surface of its kind. It stays inside the
 * surface's pane, which the positioned parent gives, and follows its size as a share of the room.
 * `still` holds it at the pane's corner, for a surface drawn by a view sized to the pill alone.
 */
export function PillDock({
  kind,
  still = false,
  className,
  onSize,
  children,
}: {
  kind: PillKind
  still?: boolean
  /** The class that stacks the pane's pill and sets its default rest. */
  className?: string
  /** The pill's size, each time it changes. */
  onSize?: (width: number, height: number) => void
  children: ReactNode
}) {
  const field = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const controls = useDragControls()
  const at = useSurfacePill((s) => s[kind])
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const [dragging, setDragging] = useState(false)

  // The drag's offset is traded for the stored place in the commit that draws it.
  useLayoutEffect(() => {
    x.stop()
    y.stop()
    x.set(0)
    y.set(0)
  }, [at, x, y])

  useEffect(() => {
    const element = dock.current
    if (!element || !onSize) return
    const observer = new ResizeObserver(() => onSize(element.offsetWidth, element.offsetHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [onSize])

  const settle = () => {
    const room = field.current?.getBoundingClientRect()
    const box = dock.current?.getBoundingClientRect()
    setDragging(false)
    if (!room || !box) return
    setSurfacePill(kind, {
      x: share(box.left - room.left, room.width - box.width),
      y: share(box.top - room.top, room.height - box.height),
    })
  }

  const grab = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('button, a, input')) return
    controls.start(event)
  }

  return (
    <div ref={field} className={cn('ctl-dock-field', className)}>
      <motion.div
        ref={dock}
        className="ctl-dock"
        data-still={still ? '' : undefined}
        data-dragging={dragging ? '' : undefined}
        style={{
          x,
          y,
          ...(at &&
            !still && {
              left: `${at.x * 100}%`,
              top: `${at.y * 100}%`,
              bottom: 'auto',
              translate: `${-at.x * 100}% ${-at.y * 100}%`,
            }),
        }}
        drag={!still}
        dragControls={controls}
        dragListener={false}
        dragConstraints={field}
        dragElastic={0}
        dragMomentum={false}
        onPointerDown={still ? undefined : grab}
        onDragStart={() => setDragging(true)}
        onDragEnd={settle}
      >
        {children}
      </motion.div>
    </div>
  )
}
