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
