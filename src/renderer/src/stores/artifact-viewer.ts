import { create } from 'zustand'

/** What the viewer lets the user do with the content: look, pin comments, or change it. */
export type ViewerMode = 'view' | 'comment' | 'edit'

/** What the right card holds, one at a time; an element picked in Edit shows its look over these. */
export type RightCard = 'comments' | 'history' | 'tweaks'

/** What a canvas's Pages card lists: every frame, the changed ones, or those with comments. */
export type PagesFilter = 'all' | 'changed' | 'comments'

/**
 * How an opened frame or a presented one is sized: the reading size, the whole frame on screen,
 * its width filling the room, or its own size.
 */
export type FitMode = 'auto' | 'screen' | 'width' | 'actual'

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
  pagesFilter: PagesFilter
  /** How an opened frame is sized. */
  fit: FitMode
}

export const VIEWER_DEFAULTS: ViewerState = {
  mode: 'view',
  left: null,
  right: null,
  version: null,
  page: null,
  opened: null,
  selection: [],
  pagesFilter: 'all',
  fit: 'auto',
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

/**
 * Shows a canvas's page with one of its frames opened at reading size, as a link to the frame or
 * a landing on a change asks; the camera follows.
 */
export function openCanvasFrame(id: string, page: string, frame: string): void {
  setViewerState(id, { page, opened: frame, selection: [frame] })
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

// Where the camera was before a frame opened, which Esc goes back to.
const before = new Map<string, ViewerCamera>()

export function cameraBeforeOpen(id: string, page: string): ViewerCamera | null {
  return before.get(`${id}\0${page}`) ?? null
}

export function keepCameraBeforeOpen(id: string, page: string, camera: ViewerCamera | null): void {
  if (camera) before.set(`${id}\0${page}`, camera)
  else before.delete(`${id}\0${page}`)
}

/** Clears cached viewer and camera state for hidden artifacts (or all when `ids` is omitted). */
export function clearArtifactViewerState(ids?: ReadonlySet<string>): void {
  if (!ids) {
    useArtifactViewerStore.setState({ byId: {} })
    cameras.clear()
    before.clear()
    return
  }
  if (ids.size === 0) return
  useArtifactViewerStore.setState((s) => {
    let changed = false
    const byId = { ...s.byId }
    for (const id of ids) {
      if (id in byId) {
        delete byId[id]
        changed = true
      }
    }
    return changed ? { byId } : s
  })
  for (const map of [cameras, before]) {
    for (const key of [...map.keys()]) {
      const id = key.slice(0, key.indexOf('\0'))
      if (ids.has(id)) map.delete(key)
    }
  }
}
