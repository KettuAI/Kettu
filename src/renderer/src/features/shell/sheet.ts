// Drag regions are inherited, and where two boxes overlap the later one wins. So the desk and what
// lies on it mark a pseudo-element covering them instead of themselves: their content keeps no
// region, and an overlay in it, even a transparent one, cannot cancel a drag bar it covers.

/** What the columns lie on, which drags the window where nothing covers it. */
export const DESK =
  'relative before:pointer-events-none before:absolute before:inset-0 before:app-region-drag'

/** Something on the desk that does not drag the window, except where a bar on it is a drag region. */
export const ON_DESK =
  'relative before:pointer-events-none before:absolute before:inset-0 before:app-region-no-drag'

/** A flat column: the main area, a page or a side pane, divided from the next by a hairline. */
export const SHEET = `${ON_DESK} overflow-clip bg-app`

/** The style of a resizable panel that holds a sheet, whose focus ring it would clip. */
export const SHEET_PANEL = { overflow: 'visible' } as const
