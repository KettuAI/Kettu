// A project's files as the Files pane lists, reads and searches them through the agent host.

import type { MediaGrant } from './media'

/** Paths are relative to the project's root, with `/` between segments on every platform. */
export interface FileList {
  paths: string[]
  /** The project holds more files than FILE_LIST_LIMIT; the list stops there. */
  truncated: boolean
}

export type FileContent =
  // `version` is the SHA-256 of the bytes; `editable` is false when they are not valid UTF-8.
  | { kind: 'text'; path: string; size: number; text: string; version: string; editable: boolean }
  // Named as media and its first bytes say which kind: not read, but granted on the media scheme.
  | { kind: 'media'; path: string; grant: MediaGrant }
  | { kind: 'binary'; path: string; size: number }
  // Larger than `limit`, which is FILE_READ_LIMIT; not read.
  | { kind: 'too-large'; path: string; size: number; limit: number }

/** A saved file's new version and size in bytes. */
export interface FileWritten {
  version: string
  size: number
}

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
export const FILE_SEARCH_LIMIT = 500
export const FILE_MATCH_CHARS = 300
