// Artifacts, as the agent host serves them to the interface. See docs/design/artifacts.md.

/** `art_` and a ULID: 26 characters of Crockford's base32, the first ten the creation time. */
export const ARTIFACT_ID = /^art_[0-9A-HJKMNP-TV-Z]{26}$/

export const ARTIFACT_TITLE_CHARS = 120

/** The session id of an artifact the user imported, which no session created. */
export const NO_SESSION = ''

/**
 * `artifact:import`: the new artifact's id, or why the file could not be imported; null when the
 * user cancelled the dialog.
 */
export type ArtifactImportResult =
  { id: string } | { failed: 'too_large' | 'not_utf8' | 'unreadable' | 'unavailable' } | null

/**
 * The viewer's frame: the page runs scripts on its own origin and may offer a download, but opens
 * no window, never moves the app's frame and cannot block on alert().
 */
export const ARTIFACT_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-downloads'

/** Longer than `max` as JSON Schema counts length: in code points, not UTF-16 units. */
export function longer(text: string, max: number): boolean {
  if (text.length <= max) return false
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) i++
    if (++n > max) return true
  }
  return false
}

/** How long a deleted artifact stays in Recently deleted before the purge removes it. */
export const ARTIFACT_KEEP_DELETED_MS = 30 * 24 * 60 * 60 * 1000

export interface ArtifactSummary {
  id: string
  title: string
  project: string // the project's folder, or a scratch folder for No project
  scratch: boolean // `project` is a scratch folder, so the artifact is under No project
  sessionId: string // the session it shows under: its latest version's, else its creator
  version: number // the latest
  pages: number // two or more is a canvas
  size: number // of the latest version, in bytes
  updatedAt: number // when the latest version was made
  deletedAt: number | null
  editing: string[] // the sessions whose running turn changed it
}

export interface VersionSummary {
  version: number
  createdAt: number
  author: string | null // a session id; null for the user
  note: string | null
  size: number
}

export interface ArtifactContent {
  title: string
  version: number
  html: string
}

/** A card's thumbnail renders at this size, a page's viewport, before main scales it down. */
export const THUMBNAIL_WIDTH = 1280
export const THUMBNAIL_HEIGHT = 800
/** Room around a canvas's pages in its thumbnail, in thumbnail pixels. */
export const THUMBNAIL_INSET = 64
/** The most pages a canvas's thumbnail lays out. */
export const THUMBNAIL_PAGES = 500

/** One page of a canvas laid out for its thumbnail, in canvas pixels, from the canvas's origin. */
export interface ThumbnailPage {
  group: number // the body's `data-page-group` child it is in, from 1, or 0 outside any
  index: number // its place among the pages there, from 1
  x: number
  y: number
  width: number
  height: number
}

/** Where a canvas's pages land in its thumbnail: scaled to fit inside the inset and centred. */
export function fitThumbnail(pages: readonly ThumbnailPage[]): {
  scale: number
  x: number
  y: number
} {
  let width = 0
  let height = 0
  for (const page of pages) {
    width = Math.max(width, page.x + page.width)
    height = Math.max(height, page.y + page.height)
  }
  if (width === 0 || height === 0) return { scale: 1, x: 0, y: 0 }
  const scale = Math.min(
    (THUMBNAIL_WIDTH - 2 * THUMBNAIL_INSET) / width,
    (THUMBNAIL_HEIGHT - 2 * THUMBNAIL_INSET) / height,
  )
  return {
    scale,
    x: (THUMBNAIL_WIDTH - width * scale) / 2,
    y: (THUMBNAIL_HEIGHT - height * scale) / 2,
  }
}

/**
 * The state an `artifacts.*` request that fails with `conflict` found, as its error's data: the
 * latest version, and whether the artifact is in Recently deleted.
 */
export interface ArtifactState {
  version: number
  deleted: boolean
}
