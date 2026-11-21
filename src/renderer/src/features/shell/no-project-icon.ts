import { Folder01Icon } from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'

/**
 * The mark of No project wherever it is shown: the line folder with a dashed stroke, a folder that
 * is not one of the user's projects.
 */
export const NO_PROJECT_ICON: IconSvgElement = Folder01Icon.map(
  ([tag, attrs]) =>
    // 13 round dashes fit the path's length; the offset keeps the tab clear at 13-16 px
    [tag, { ...attrs, strokeDasharray: '1.75 3.708', strokeDashoffset: 2 }] as const,
)
