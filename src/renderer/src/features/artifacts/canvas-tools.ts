// The canvas editor's tools: their names, icons and the colors notes take.

import {
  ArrowUpRight01Icon,
  CircleIcon,
  Comment01Icon,
  Cursor01Icon,
  GridIcon,
  GroupItemsIcon,
  HandGripIcon,
  HighlighterIcon,
  Layers01Icon,
  LineIcon,
  Pen01Icon,
  RectangularIcon,
  StickyNote01Icon,
  TextFontIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import type { NoteColor } from '@shared/canvas-doc'

export type Tool =
  'move' | 'hand' | 'page' | 'section' | 'text' | 'sticky' | 'pen' | 'shape' | 'comment'
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow'

export interface PenStyle {
  marker: boolean
  color: NoteColor
  width: number
}

export const NOTE_COLOR_VAR: Record<NoteColor, string> = {
  ink: 'var(--note-ink)',
  red: 'var(--note-red)',
  orange: 'var(--note-orange)',
  yellow: 'var(--note-yellow)',
  green: 'var(--note-green)',
  blue: 'var(--note-blue)',
  violet: 'var(--note-violet)',
}

export const TOOL_ICONS: Record<Tool, IconSvgElement> = {
  move: Cursor01Icon,
  hand: HandGripIcon,
  page: GridIcon,
  section: GroupItemsIcon,
  text: TextFontIcon,
  sticky: StickyNote01Icon,
  pen: Pen01Icon,
  shape: RectangularIcon,
  comment: Comment01Icon,
}
export const SHAPE_ICONS: Record<ShapeKind, IconSvgElement> = {
  rect: RectangularIcon,
  ellipse: CircleIcon,
  line: LineIcon,
  arrow: ArrowUpRight01Icon,
}
export const MARKER_ICON = HighlighterIcon
export const LAYERS_ICON = Layers01Icon
