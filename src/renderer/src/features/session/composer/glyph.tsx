import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

/** A line icon at the shell's stroke, sized by `size` or by a size class. */
export function Glyph({
  icon,
  size = 16,
  className,
  'data-icon': slot = '',
}: {
  icon: IconSvgElement
  size?: number
  className?: string
  /** Where a button places it, as `inline-start` or `inline-end`. */
  'data-icon'?: string
}) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={1.9}
      className={className}
      aria-hidden
      data-icon={slot}
    />
  )
}
