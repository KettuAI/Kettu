import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { cn } from '@renderer/lib/utils'

export interface Segment<T extends string> {
  value: T
  /** The label, or a function of whether the thumb is on this segment. */
  label: ReactNode | ((active: boolean) => ReactNode)
}

interface Box {
  x: number
  width: number
}

const segmentsOf = (group: HTMLElement): HTMLElement[] => [
  ...group.querySelectorAll<HTMLElement>(':scope > [data-slot=toggle-group-item]'),
]

/**
 * Segments on a recessed track, each as wide as its label and sharing any room left, with one
 * thumb that slides to the chosen segment. Pressing and dragging moves the thumb segment by
 * segment, and the segment under the pointer is chosen on release. The thumb is placed from the
 * segments' measured boxes and moves by `translate`; its width changes only between segments of
 * different widths, and its containment keeps that layout to itself.
 */
export function SegmentedControl<T extends string>({
  value,
  segments,
  onChange,
  thumbClassName,
  thumb,
  className,
  itemClassName,
  ...aria
}: {
  value: T
  segments: readonly Segment<T>[]
  onChange: (value: T) => void
  /** Extra styles for the thumb while it is on a given segment, such as a tinted ring. */
  thumbClassName?: (value: T) => string | undefined
  /** Content painted inside the thumb, under the segment's label. */
  thumb?: ReactNode
  className?: string
  /** Layout for each segment, such as tighter padding where many share a narrow track. */
  itemClassName?: string
  'aria-label'?: string
  'aria-labelledby'?: string
}) {
  const group = useRef<HTMLDivElement>(null)
  // The segment under the pointer while it is pressed.
  const [pressed, setPressed] = useState<number | null>(null)
  const [box, setBox] = useState<Box | null>(null)
  // The first placement is not animated, so the thumb never slides in from the track's edge.
  const [placed, setPlaced] = useState(false)
  const index = segments.findIndex((s) => s.value === value)
  const active = pressed ?? index

  useLayoutEffect(() => {
    const el = group.current
    if (!el) return
    const measure = () => {
      const item = segmentsOf(el)[active]
      setBox((b) =>
        !item
          ? null
          : b?.x === item.offsetLeft && b.width === item.offsetWidth
            ? b
            : { x: item.offsetLeft, width: item.offsetWidth },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const item of segmentsOf(el)) observer.observe(item)
    return () => observer.disconnect()
  }, [active, segments.length])

  useLayoutEffect(() => {
    if (!box || placed) return
    const frame = requestAnimationFrame(() => setPlaced(true))
    return () => cancelAnimationFrame(frame)
  }, [box, placed])

  const segmentAt = (clientX: number): number => {
    const items = group.current ? segmentsOf(group.current) : []
    let nearest = Math.max(0, index)
    let distance = Infinity
    items.forEach((item, i) => {
      const r = item.getBoundingClientRect()
      const d = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0
      if (d < distance) {
        distance = d
        nearest = i
      }
    })
    return nearest
  }

  // With the pointer captured, the click lands on the group rather than a segment, so the pointer
  // handlers alone choose; the keyboard still goes through the toggle group.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setPressed(segmentAt(event.clientX))
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (pressed === null) return
    const at = segmentAt(event.clientX)
    if (at !== pressed) setPressed(at)
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (pressed === null) return
    setPressed(null)
    const picked = segments[segmentAt(event.clientX)]
    if (picked.value !== value) onChange(picked.value)
  }

  return (
    <ToggleGroup
      {...aria}
      ref={group}
      variant="segmented"
      size="compact"
      spacing={0.5}
      value={[value]}
      onValueChange={(next) => {
        const picked = segments.find((s) => s.value === next[0])
        if (picked && picked.value !== value) onChange(picked.value)
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setPressed(null)}
      className={cn('relative', className)}
    >
      {box && active >= 0 && (
        <span
          aria-hidden
          data-slot="segmented-thumb"
          className={cn(
            'pointer-events-none absolute inset-y-0.5 left-0 overflow-hidden rounded-md bg-segment-thumb shadow-segment contain-strict',
            placed &&
              'transition-[translate,width,scale,box-shadow] duration-(--duration-base) ease-(--ease-out-quart) motion-reduce:transition-none',
            pressed !== null && 'scale-97',
            thumbClassName?.(segments[active].value),
          )}
          style={{ width: box.width, translate: `${box.x}px 0` } satisfies CSSProperties}
        >
          {thumb}
        </span>
      )}
      {segments.map((s, i) => (
        <ToggleGroupItem
          key={s.value}
          value={s.value}
          data-active={i === active || undefined}
          className={cn('relative flex-auto', itemClassName)}
        >
          <span className="truncate">
            {typeof s.label === 'function' ? s.label(i === active) : s.label}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
