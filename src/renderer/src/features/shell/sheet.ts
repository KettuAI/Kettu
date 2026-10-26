// Drag regions are inherited, and where two boxes overlap the later one wins. So the desk and what
// lies on it mark a pseudo-element covering them instead of themselves: their content keeps no
// region, and an overlay in it, even a transparent one, cannot cancel a drag bar it covers.

/** The desk the sheets lie on, which drags the window. */
export const DESK =
  'relative before:pointer-events-none before:absolute before:inset-0 before:app-region-drag'

/** Something on the desk that does not drag the window, except where a bar on it is a drag region. */
export const ON_DESK =
  'relative before:pointer-events-none before:absolute before:inset-0 before:app-region-no-drag'

/** A sheet laid on the desk: the main area, a page or a side pane. */
export const SHEET = `${ON_DESK} overflow-clip rounded-xl bg-app shadow-sheet`

/** The style of a resizable panel that holds a sheet, whose ring and shadow it would clip. */
export const SHEET_PANEL = { overflow: 'visible' } as const
