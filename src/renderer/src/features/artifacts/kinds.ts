import { createElement, type SVGProps } from 'react'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
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

type KindIconProps = Omit<SVGProps<SVGSVGElement>, 'ref' | 'strokeWidth'>

/** A kind's icon as a component sized by its class, at the redesign's stroke. */
function drawn(icon: IconSvgElement) {
  return function KindIcon(props: KindIconProps) {
    return createElement(HugeiconsIcon, { 'aria-hidden': true, ...props, icon, strokeWidth: 1.9 })
  }
}

/**
 * Each kind's icon, and its color and tint, which only its icon and the grounds of its tile and
 * thumbnail carry; `tileHover` deepens the tile's ground.
 */
export const KIND_LOOK: Record<
  ArtifactKind,
  {
    icon: (props: KindIconProps) => React.JSX.Element
    color: string
    tint: string
    tileHover: string
  }
> = {
  document: {
    icon: drawn(KIND_ICON.document),
    color: 'text-kind-document',
    tint: 'bg-kind-document-tint',
    tileHover:
      'group-hover/tile:bg-[color-mix(in_srgb,var(--kind-document-tint),var(--text-primary)_5%)]',
  },
  slides: {
    icon: drawn(KIND_ICON.slides),
    color: 'text-kind-slides',
    tint: 'bg-kind-slides-tint',
    tileHover:
      'group-hover/tile:bg-[color-mix(in_srgb,var(--kind-slides-tint),var(--text-primary)_5%)]',
  },
  web: {
    icon: drawn(KIND_ICON.web),
    color: 'text-kind-web',
    tint: 'bg-kind-web-tint',
    tileHover:
      'group-hover/tile:bg-[color-mix(in_srgb,var(--kind-web-tint),var(--text-primary)_5%)]',
  },
  canvas: {
    icon: drawn(KIND_ICON.canvas),
    color: 'text-kind-canvas',
    tint: 'bg-kind-canvas-tint',
    tileHover:
      'group-hover/tile:bg-[color-mix(in_srgb,var(--kind-canvas-tint),var(--text-primary)_5%)]',
  },
}
