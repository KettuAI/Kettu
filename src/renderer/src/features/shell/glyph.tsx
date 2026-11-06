import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'

/**
 * A Hugeicons glyph at App Shell's stroke, for Kettu's own controls and menus; `className` sizes and
 * colors it where a menu or button sets them on its icons.
 */
export function Glyph({
  icon,
  size = 16,
  className,
}: {
  icon: IconSvgElement
  size?: number
  className?: string
}) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={1.9}
      color="currentColor"
      aria-hidden
      className={className}
    />
  )
}
