import { createElement } from 'react'
import { AiProgrammingIcon } from '@hugeicons/core-free-icons'

// Minion Code has no mark of its own, so a neutral glyph from the app's icon set stands in.
export const viewBox = '0 0 24 24'

/** The glyph in `currentColor`, at every size. */
export function Body() {
  return <g fill="none">{AiProgrammingIcon.map(([tag, attrs]) => createElement(tag, attrs))}</g>
}
