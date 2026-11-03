import type { CSSProperties, ReactNode } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { useSegmentThumb, type SegmentBox } from '@renderer/hooks/use-segment-thumb'
import { cn } from '@renderer/lib/utils'

export interface Segment<T extends string> {
  value: T
  /** The label, or a function of whether the thumb is on this segment. */
  label: ReactNode | ((active: boolean) => ReactNode)
}

/** The raised thumb under the chosen segment, sliding by `translate` from one to the next. */
export function SegmentThumb({
  box,
  placed,
  pressed,
  className,
  children,
}: {
  box: SegmentBox | null
  placed: boolean
  pressed: boolean
  className?: string
  children?: ReactNode
}) {
  if (!box) return null
  // Its width changes only between segments of different widths, and containment keeps that
  // layout to itself.
  return (
    <span
      aria-hidden
      data-slot="segmented-thumb"
      className={cn(
        'pointer-events-none absolute inset-y-0.5 left-0 overflow-hidden rounded-segment bg-segment-thumb shadow-segment contain-strict',
        placed &&
          'transition-[translate,width,scale,box-shadow] duration-(--duration-base) ease-standard motion-reduce:transition-none',
        pressed && 'scale-97',
        className,
      )}
      style={{ width: box.width, translate: `${box.x}px 0` } satisfies CSSProperties}
    >
      {children}
    </span>
  )
}

/**
 * Segments on a recessed track, each as wide as its label and sharing any room left, with one
 * thumb that slides to the chosen segment and follows a press dragged across them.
 */
export function SegmentedControl<T extends string>({
  value,
  segments,
  onChange,
  thumbClassName,
  thumb,
  size = 'default',
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
  /** `small` sits in a pane's or a block's header: tighter corners and no ring around the track. */
  size?: 'default' | 'small'
  className?: string
  /** Layout for each segment, such as tighter padding where many share a narrow track. */
  itemClassName?: string
  'aria-label'?: string
  'aria-labelledby'?: string
}) {
  const index = segments.findIndex((s) => s.value === value)
  const {
    group,
    active,
    handlers,
    thumb: place,
  } = useSegmentThumb(index, segments.length, (at) => onChange(segments[at].value))

  return (
    <ToggleGroup
      {...aria}
      ref={group}
      variant="segmented"
      spacing={0.5}
      value={[value]}
      onValueChange={(next) => {
        const picked = segments.find((s) => s.value === next[0])
        if (picked && picked.value !== value) onChange(picked.value)
      }}
      {...handlers}
      className={cn(
        'relative',
        size === 'small' &&
          'data-[variant=segmented]:rounded-tile data-[variant=segmented]:shadow-none',
        className,
      )}
    >
      <SegmentThumb
        {...place}
        className={cn(
          size === 'small' && 'rounded-md',
          active >= 0 && thumbClassName?.(segments[active].value),
        )}
      >
        {thumb}
      </SegmentThumb>
      {segments.map((s, i) => (
        <ToggleGroupItem
          key={s.value}
          value={s.value}
          // No toggle size: its height utility would outrank an itemClassName height.
          size={null}
          data-active={i === active || undefined}
          className={cn(
            "relative h-6.5 flex-auto rounded-segment px-2.5 text-hint font-medium [&_svg:not([class*='size-'])]:size-3.5",
            size === 'small' && 'rounded-md',
            itemClassName,
          )}
        >
          <span className="truncate">
            {typeof s.label === 'function' ? s.label(i === active) : s.label}
          </span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
