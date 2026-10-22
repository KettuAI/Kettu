// A project's files as the Files pane lists, reads and searches them through the agent host.

/** Paths are relative to the project's root, with `/` between segments on every platform. */
export interface FileList {
  paths: string[]
  /** The project holds more files than FILE_LIST_LIMIT; the list stops there. */
  truncated: boolean
}

export type FileContent =
  | { kind: 'text'; path: string; size: number; text: string }
  // A picture named as one whose first bytes say which kind, read whole as base64.
  | { kind: 'image'; path: string; size: number; mimeType: ImageType; data: string }
  | { kind: 'binary'; path: string; size: number }
  // Larger than `limit`, FILE_READ_LIMIT or FILE_IMAGE_LIMIT for an image; not read.
  | { kind: 'too-large'; path: string; size: number; limit: number }

/** The picture formats Chromium shows that the preview reads. */
export type ImageType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'image/bmp'
  | 'image/x-icon'

export interface FileMatch {
  path: string
  line: number // 1-based
  text: string // the line, cut to FILE_MATCH_CHARS
}

export interface FileSearch {
  matches: FileMatch[]
  /** More lines match than FILE_SEARCH_LIMIT. */
  truncated: boolean
}

export const FILE_LIST_LIMIT = 50_000
export const FILE_READ_LIMIT = 1024 * 1024
// An image goes to the renderer whole, as base64 in a `data:` URL, which the CSP already allows.
export const FILE_IMAGE_LIMIT = 10_000_000
export const FILE_SEARCH_LIMIT = 500
export const FILE_MATCH_CHARS = 300
