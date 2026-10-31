import { AppWindowIcon, FrameIcon, type LucideIcon } from 'lucide-react'
import type { ArtifactKind } from './model'

/**
 * Each kind's icon, and its color and tint, which only its icon and the grounds of its tile and
 * thumbnail carry; `tileHover` deepens the tile's ground.
 */
export const KIND_LOOK: Record<
  ArtifactKind,
  { icon: LucideIcon; color: string; tint: string; tileHover: string }
> = {
  web: {
    icon: AppWindowIcon,
    color: 'text-kind-web',
    tint: 'bg-kind-web-tint',
    tileHover:
      'group-hover/tile:bg-[color-mix(in_srgb,var(--kind-web-tint),var(--text-primary)_5%)]',
  },
  canvas: {
    icon: FrameIcon,
    color: 'text-kind-canvas',
    tint: 'bg-kind-canvas-tint',
    tileHover:
      'group-hover/tile:bg-[color-mix(in_srgb,var(--kind-canvas-tint),var(--text-primary)_5%)]',
  },
}
