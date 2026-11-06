import {
  AppWindowIcon,
  FileTextIcon,
  FrameIcon,
  PresentationIcon,
  type LucideIcon,
} from 'lucide-react'
import {
  File01Icon,
  Globe02Icon,
  PaintBoardIcon,
  Presentation01Icon,
} from '@hugeicons/core-free-icons'
import type { MenuItem } from '@renderer/components/affect/app-shell'
import type { ArtifactKind } from './model'

/** Each kind's icon on the Artifacts page: its tabs, menus and the kinds to ask for. */
export const KIND_ICON: Record<ArtifactKind, NonNullable<MenuItem['icon']>> = {
  document: File01Icon,
  slides: Presentation01Icon,
  web: Globe02Icon,
  canvas: PaintBoardIcon,
}

/**
 * Each kind's icon, and its color and tint, which only its icon and the grounds of its tile and
 * thumbnail carry; `tileHover` deepens the tile's ground.
 */
export const KIND_LOOK: Record<
  ArtifactKind,
  { icon: LucideIcon; color: string; tint: string; tileHover: string }
> = {
  document: {
    icon: FileTextIcon,
    color: 'text-kind-document',
    tint: 'bg-kind-document-tint',
    tileHover:
      'group-hover/tile:bg-[color-mix(in_srgb,var(--kind-document-tint),var(--text-primary)_5%)]',
  },
  slides: {
    icon: PresentationIcon,
    color: 'text-kind-slides',
    tint: 'bg-kind-slides-tint',
    tileHover:
      'group-hover/tile:bg-[color-mix(in_srgb,var(--kind-slides-tint),var(--text-primary)_5%)]',
  },
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
