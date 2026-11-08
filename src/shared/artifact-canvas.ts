// What the agent host and its clients say about a canvas being worked on.

import type { CanvasDoc, CanvasOp } from './canvas-doc'

/** The note of the version that split an old canvas into the canvas format, which clients name. */
export const CANVAS_SPLIT_NOTE = 'kettu:canvas-split'

/** `artifacts.canvas`: the live document a client starts from. */
export interface CanvasState {
  /** The latest version. */
  version: number
  /** Counts each change the host applied, for ordering what follows. */
  seq: number
  /** Null for an old canvas, still one `index.html`, or an artifact that is no canvas. */
  doc: CanvasDoc | null
  /** An old canvas: the first change on it splits it into the canvas format. */
  legacy: boolean
}

/**
 * `artifacts.canvas` event: operations a client sent, in the order the host applied them, which
 * the client that sent them knows by `client` and `clientSeq`; or the whole document again after
 * a version from elsewhere.
 */
export interface CanvasEvent {
  id: string
  seq: number
  ops?: CanvasOp[]
  client?: string
  clientSeq?: number
  doc?: CanvasDoc
  version?: number
}
