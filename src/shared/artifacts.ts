// Artifacts, as the agent host serves them to the interface.

import type { ArtifactTypeInfo, ArtifactTypeName } from './artifact-types'

/** `art_` and a ULID: 26 characters of Crockford's base32, the first ten the creation time. */
export const ARTIFACT_ID = /^art_[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * How a window names an artifact to main: its id, or for an artifact of another host the host's id
 * before it, so two hosts' artifacts never meet, even under one id.
 */
const ARTIFACT_REF = /^(?:([0-9a-f]{32}):)?(art_[0-9A-HJKMNP-TV-Z]{26})$/

export function artifactRef(hostId: string | null, id: string): string {
  return hostId === null ? id : `${hostId}:${id}`
}

/** The host and id a reference names, the host null for this computer's; null for anything else. */
export function parseArtifactRef(ref: unknown): { hostId: string | null; id: string } | null {
  const match = typeof ref === 'string' ? ARTIFACT_REF.exec(ref) : null
  return match ? { hostId: match[1] ?? null, id: match[2]! } : null
}

export const ARTIFACT_TITLE_CHARS = 120

/** The session id of an artifact the user imported, which no session created. */
export const NO_SESSION = ''

/**
 * Why an import failed: a file or the whole over the limits, more files than a version holds, a
 * folder without an `index.html`, a name no artifact file may have, HTML that is not UTF-8, or
 * what could not be read; `unavailable` when the agent host cannot take it.
 */
export type ArtifactImportFailure =
  | 'too_large'
  | 'too_many'
  | 'no_index'
  | 'bad_canvas'
  | 'bad_name'
  | 'not_utf8'
  | 'unreadable'
  | 'unavailable'

/**
 * `artifact:import`: the new artifact's id, or why the file or folder could not be imported; null
 * when the user cancelled the dialog.
 */
export type ArtifactImportResult = { id: string } | { failed: ArtifactImportFailure } | null

/** What `artifact:import` asks the user for: one HTML file, or a folder with an `index.html`. */
export type ArtifactImportKind = 'file' | 'folder'

/**
 * The viewer's frame: the page runs scripts on its own origin and may offer a download, but opens
 * no window, never moves the app's frame and cannot block on alert().
 */
export const ARTIFACT_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-downloads'

/**
 * The web client's frames: its artifacts all load on the page's own origin, so a frame never has
 * same-origin, and the host serves them on an opaque origin besides.
 */
export const WEB_ARTIFACT_FRAME_SANDBOX = 'allow-scripts allow-forms allow-downloads'

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

/**
 * The `reason` in the data of an error for a version whose stored files are gone from the host,
 * which reading again cannot bring back.
 */
export const CONTENT_MISSING = 'content_missing'

export interface ArtifactSummary {
  id: string
  title: string
  project: string // the project's folder, or a scratch folder for No project
  scratch: boolean // `project` is a scratch folder, so the artifact is under No project
  sessionId: string // the session it shows under: its latest version's, else its creator
  version: number // the latest
  pages: number // two or more is a canvas
  canvas: boolean // the latest version is a canvas document, whatever its page count
  files: number // of the latest version
  size: number // of the latest version, in bytes
  createdAt: number // when the artifact was made
  updatedAt: number // when the latest version was made
  deletedAt: number | null
  editing: string[] // the sessions whose running turn changed it
  type: ArtifactTypeName | null // the type it was made from, shown by the type's viewer
}

/** A session using an artifact now: its running turn read it, or changed it. */
export interface ArtifactSession {
  sessionId: string
  editing: boolean // its running turn changed it; false while it only reads
  /** What it did last, which its pointer shows: read, write a file, add a page or move one. */
  doing?: ArtifactDoing
  /** Where it did it: a file, the start tag of the element it changed in that file, a canvas page. */
  focus?: ArtifactFocus
}

export type ArtifactDoing = 'read' | 'write' | 'draw' | 'move'

export interface ArtifactFocus {
  path: string | null
  offset: number | null
  page: string | null
}

export interface VersionSummary {
  version: number
  createdAt: number
  author: string | null // a session id; null for the user
  note: string | null
  size: number
}

/** A file of an artifact's version: its path, its size in bytes and the type it is served with. */
export interface ArtifactFileInfo {
  path: string
  size: number
  type: string
  /** The bytes' hash, the same in every version that has the same file; absent from older hosts. */
  hash?: string
}

export interface ArtifactContent {
  title: string
  version: number
  /** The entry page's text; empty for an artifact made from a type, whose viewer is its page, and for a canvas document without one. */
  html: string
  files: ArtifactFileInfo[]
  type?: ArtifactTypeInfo | null
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
  file?: string // a canvas document's page: its own HTML file
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
  /** For a write refused because someone changed what it writes: those files, since its base. */
  changed?: string[]
}
