import foxUrl from '@renderer/assets/kettu-fox.svg'
import { lockupGeometry, WORDMARK, type LockupLayout } from '@shared/brand'
import type { AppIcon } from '@shared/settings'
import { appIconUrl } from '@renderer/lib/app-icons'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings-store'

function isWebRuntime(): boolean {
  return typeof window !== 'undefined' && window.kettu?.client === 'web'
}

/** The icon's shaded fox without its tile; one drawing holds on light and dark grounds. Decorative. */
export function BrandFox({ className }: { className?: string }) {
  return (
    <img alt="" src={foxUrl} draggable={false} className={cn('inline-block shrink-0', className)} />
  )
}

/**
 * The app's icon, `size` px square. Decorative. Follows the user's selected desktop app icon
 * unless `icon` pins a specific variant (such as the official publisher mark).
 */
export function BrandIcon({
  size,
  icon,
  className,
}: {
  size: number
  icon?: AppIcon
  className?: string
}) {
  const chosen = useSettingsStore((s) => s.settings.appearance.appIcon)
  const effective = icon ?? (isWebRuntime() ? 'kettu' : chosen)
  return (
    <img
      alt=""
      src={appIconUrl(effective)}
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
      <image
        href={appIconUrl('kettu')}
        x={icon.x}
        y={icon.y}
        width={icon.size}
        height={icon.size}
      />
      <path transform={`translate(${text.x} ${text.y})`} d={WORDMARK.path} />
    </svg>
  )
}
