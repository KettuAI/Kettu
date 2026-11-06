import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

/**
 * A Hugeicons glyph at App Shell's stroke, for Kettu's own controls and menus; `className` sizes and
 * colors it where a menu or button sets them on its icons.
 */
export function Glyph({
  icon,
  size = 16,
  className,
  'data-icon': slot,
}: {
  icon: IconSvgElement
  size?: number
  className?: string
  /** Where a button places it, as its `data-icon` styles say. */
  'data-icon'?: 'inline-start' | 'inline-end'
}) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={1.9}
      color="currentColor"
      aria-hidden
      className={className}
      data-icon={slot}
    />
  )
}

/** A menu item's glyph in the menus' icon color, which they give only to Lucide's icons. */
export function MenuGlyph({ icon }: { icon: IconSvgElement }) {
  return <Glyph icon={icon} size={15} className="text-icon" />
}
