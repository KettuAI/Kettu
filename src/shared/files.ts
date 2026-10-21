// A project's files as the Files pane lists, reads and searches them through the agent host.

/** Paths are relative to the project's root, with `/` between segments on every platform. */
export interface FileList {
  paths: string[]
  /** The project holds more files than FILE_LIST_LIMIT; the list stops there. */
  truncated: boolean
}

export type FileContent =
  | { kind: 'text'; path: string; size: number; text: string }
  | { kind: 'binary'; path: string; size: number }
  // Larger than FILE_READ_LIMIT; not read.
  | { kind: 'too-large'; path: string; size: number }

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
