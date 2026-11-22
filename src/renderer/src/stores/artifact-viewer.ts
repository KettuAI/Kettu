import { create } from 'zustand'

/** What the viewer lets the user do with the content: look, pin comments, or change it. */
export type ViewerMode = 'view' | 'comment' | 'edit'

/** What the right card holds, one at a time; an element picked in Edit shows its look over these. */
export type RightCard = 'comments' | 'history' | 'tweaks'

/** Where a canvas's camera was, in screen pixels at zoom `z`. */
export interface ViewerCamera {
  x: number
  y: number
  z: number
  /** Whether it was fitted to the pages, so it fits them again in another size. */
  fitted: boolean
}

/**
 * What an open artifact's viewer carries across Expand, Restore, Chat and a change of width tier,
 * which unmount or reflow it: kept here, by artifact, instead of in the viewer's own state.
 */
export interface ViewerState {
  mode: ViewerMode
  /** The left card as the user left it; null follows the width tier. */
  left: boolean | null
  right: RightCard | null
  /** An earlier version on screen, from the history; null for the latest. */
  version: number | null
  /** A canvas document's canvas on screen, or null for its first. */
  page: string | null
  /** The frame opened at reading size, by its id; for a canvas of one file, its page index. */
  opened: string | null
  /** The frames selected on the canvas. */
  selection: readonly string[]
}

export const VIEWER_DEFAULTS: ViewerState = {
  mode: 'view',
  left: null,
  right: null,
  version: null,
  page: null,
  opened: null,
  selection: [],
}

interface ArtifactViewerStore {
  byId: Record<string, ViewerState>
}

export const useArtifactViewerStore = create<ArtifactViewerStore>()(() => ({ byId: {} }))

/** An artifact's viewer state, or the defaults until something changes it. */
export function viewerStateOf(id: string): ViewerState {
  return useArtifactViewerStore.getState().byId[id] ?? VIEWER_DEFAULTS
}

export function useViewerState<T>(id: string, pick: (state: ViewerState) => T): T {
  return useArtifactViewerStore((s) => pick(s.byId[id] ?? VIEWER_DEFAULTS))
}

export function setViewerState(
  id: string,
  patch: Partial<ViewerState> | ((state: ViewerState) => Partial<ViewerState>),
): void {
  useArtifactViewerStore.setState((s) => {
    const was = s.byId[id] ?? VIEWER_DEFAULTS
    const next = { ...was, ...(typeof patch === 'function' ? patch(was) : patch) }
    const same = (Object.keys(next) as Array<keyof ViewerState>).every((k) => next[k] === was[k])
    return same ? s : { byId: { ...s.byId, [id]: next } }
  })
}

// The camera moves every frame, so it is kept apart from what renders.
const cameras = new Map<string, ViewerCamera>()

/** The camera a canvas left, by artifact and canvas. */
export function savedCamera(id: string, page: string): ViewerCamera | null {
  return cameras.get(`${id}\0${page}`) ?? null
}

export function saveCamera(id: string, page: string, camera: ViewerCamera): void {
  cameras.set(`${id}\0${page}`, camera)
}
