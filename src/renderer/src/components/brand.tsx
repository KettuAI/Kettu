import iconUrl from '@renderer/assets/kettu-icon.svg'
import { lockupGeometry, WORDMARK, type LockupLayout } from '@shared/brand'
import { cn } from '@renderer/lib/utils'

/** The app's icon, `size` px square. Decorative. */
export function BrandIcon({ size, className }: { size: number; className?: string }) {
  return (
    <img
      alt=""
      src={iconUrl}
      width={size}
      height={size}
      draggable={false}
      className={cn('shrink-0', className)}
    />
  )
}

/** The icon and the wordmark in their fixed proportions, sized by the wordmark's font size. */
export function BrandLockup({
  fontSize,
  layout = 'horizontal',
  className,
}: {
  fontSize: number
  layout?: LockupLayout
  className?: string
}) {
  const g = lockupGeometry(layout)
  const scale = fontSize / 100
  const { icon, text } = g
  return (
    <svg
      role="img"
      aria-label="Kettu"
      viewBox={`0 0 ${g.width} ${g.height}`}
      width={g.width * scale}
      height={g.height * scale}
      fill="currentColor"
      className={cn('shrink-0 text-primary', className)}
    >
      <image href={iconUrl} x={icon.x} y={icon.y} width={icon.size} height={icon.size} />
      <path transform={`translate(${text.x} ${text.y})`} d={WORDMARK.path} />
    </svg>
  )
}
