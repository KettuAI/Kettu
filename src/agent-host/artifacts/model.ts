// The artifact records the thread worker keeps, and the calls the host makes on them.

import type { ArtifactSummary } from '@shared/artifacts'
import type { ArtifactTypeInfo } from '@shared/artifact-types'

export interface ArtifactRecord {
  id: string
  project: string
  title: string
  head: number
  sessionId: string // the session that created it
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface VersionRecord {
  version: number
  size: number // of all its files
  pages: number // the entry page's
  author: string | null
  note: string | null
  createdAt: number
}

/** One file of a version: its path in the artifact, and the content file holding its bytes. */
export interface StoredFile {
  path: string
  hash: string
  size: number
}

/** A file a new version puts at `path`, or removes from it when `data` is null. */
export interface FileChange {
  path: string
  data: Uint8Array | null
}

/** A summary as the store knows it; the host adds whether its project is a scratch folder. */
export type StoredSummary = Omit<ArtifactSummary, 'scratch'>

export type ArtifactListing = Omit<StoredSummary, 'editing'>

/**
 * `project` is the reach of a session: the artifacts of its project, outside Recently deleted.
 * Null is the user's, who reaches every artifact.
 */
export interface ArtifactCalls {
  /** Newest first; Recently deleted by when each went, and for the user only. */
  list: {
    params: { project: string } | { project: null; deleted: boolean }
    result: ArtifactListing[]
  }
  /** The artifact with one of its versions, the latest when `version` is null, and its files. */
  get: {
    params: { id: string; version: number | null; project: string | null }
    result: {
      artifact: ArtifactRecord
      version: VersionRecord
      files: StoredFile[]
      /** The version's type and format; null for a plain artifact. */
      type: ArtifactTypeInfo | null
    }
  }
  /** Newest first. */
  versions: { params: { id: string; project: string | null }; result: VersionRecord[] }
  create: {
    params: {
      id: string
      project: string
      sessionId: string
      title: string
      files: { path: string; data: Uint8Array }[]
      pages: number
      note: string | null
      at: number
      /** Made from a type, whose content the caller checked. */
      type?: ArtifactTypeInfo | null
    }
    result: { version: number }
  }
  /**
   * A new version from `baseVersion`, which must be the latest: its files with `changes` made to
   * them, the rest as they were.
   */
  write: {
    params: {
      id: string
      project: string | null
      baseVersion: number
      changes: FileChange[]
      pages: number
      author: string | null
      note: string | null
      at: number
      /** The new version's type and format: a typed artifact's must name its type, a plain one none. */
      type?: ArtifactTypeInfo | null
    }
    result: { version: number }
  }
  /** `version` again as the newest, sharing its files. */
  restore: {
    params: {
      id: string
      project: string | null
      version: number
      baseVersion: number
      author: string | null
      note: string | null
      at: number
    }
    result: { version: number }
  }
  rename: { params: { id: string; project: string | null; title: string }; result: null }
  /** Into Recently deleted; an artifact there keeps the time it went, and `changed` is false. */
  delete: {
    params: { id: string; project: string | null; at: number }
    result: { deletedAt: number; changed: boolean }
  }
  /** Back from Recently deleted; false when it was not there. */
  undelete: { params: { id: string }; result: { changed: boolean } }
  /** Removes an artifact in Recently deleted for good, with the files no other version names. */
  erase: { params: { id: string }; result: null }
  /** Removes what was deleted before `before`, then every file no version names. */
  purge: { params: { before: number }; result: { artifacts: number; files: number } }
}

export type ArtifactCallName = keyof ArtifactCalls

export type ArtifactCall = {
  [K in ArtifactCallName]: { name: K; params: ArtifactCalls[K]['params'] }
}[ArtifactCallName]
