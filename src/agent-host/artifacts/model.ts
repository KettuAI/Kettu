// The artifact records the thread worker keeps, and the calls the host makes on them.

import type { ArtifactSummary } from '@shared/artifacts'

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
  hash: string
  size: number
  pages: number
  author: string | null
  note: string | null
  createdAt: number
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
  /** The artifact with one of its versions, the latest when `version` is null. */
  get: {
    params: { id: string; version: number | null; project: string | null }
    result: { artifact: ArtifactRecord; version: VersionRecord }
  }
  /** Newest first. */
  versions: { params: { id: string; project: string | null }; result: VersionRecord[] }
  create: {
    params: {
      id: string
      project: string
      sessionId: string
      title: string
      html: string
      pages: number
      note: string | null
      at: number
    }
    result: { version: number }
  }
  /** A new version from `baseVersion`, which must be the latest. */
  write: {
    params: {
      id: string
      project: string | null
      baseVersion: number
      html: string
      pages: number
      author: string | null
      note: string | null
      at: number
    }
    result: { version: number }
  }
  /** `version` again as the newest, sharing its file. */
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
