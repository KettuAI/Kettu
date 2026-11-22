// What the canvas draws its notes with: their colors and the icons that name them in lists.

import {
  ArrowUpRight01Icon,
  CircleIcon,
  GridIcon,
  LineIcon,
  Pen01Icon,
  RectangularIcon,
  StickyNote01Icon,
  TextFontIcon,
  WorkflowSquare10Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import type { CanvasNote, NoteColor } from '@shared/canvas-doc'

export const NOTE_COLOR_VAR: Record<NoteColor, string> = {
  ink: 'var(--note-ink)',
  red: 'var(--note-red)',
  orange: 'var(--note-orange)',
  yellow: 'var(--note-yellow)',
  green: 'var(--note-green)',
  blue: 'var(--note-blue)',
  violet: 'var(--note-violet)',
}

export const FRAME_ICON = GridIcon

export const NOTE_ICONS: Record<CanvasNote['kind'] | 'canvas', IconSvgElement> = {
  canvas: WorkflowSquare10Icon,
  text: TextFontIcon,
  sticky: StickyNote01Icon,
  pen: Pen01Icon,
  rect: RectangularIcon,
  ellipse: CircleIcon,
  line: LineIcon,
  arrow: ArrowUpRight01Icon,
}
