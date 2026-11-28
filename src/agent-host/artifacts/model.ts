// The artifact records the thread worker keeps, and the calls the host makes on them.

import type { CommentAnchor, CommentAuthor, CommentThread } from '@shared/artifact-comments'
import type { ArtifactSummary } from '@shared/artifacts'
import type { ArtifactTypeInfo } from '@shared/artifact-types'
import type { ArtifactBrief } from '@shared/host-control'
import type { Declaration } from './runtime/calls'

export interface ArtifactRecord {
  id: string
  project: string
  title: string
  head: number
  sessionId: string // the session that created it
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  /** The newest version its owner had open in a viewer; null until they open it. */
  seen: number | null
  /** The Kettu account id owning this artifact, or null for an unowned purely local artifact. */
  ownerAccountId: string | null
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
 * Null is the user's, who reaches every artifact visible to `accountId`.
 */
export interface ArtifactCalls {
  /** Newest first; Recently deleted by when each went, and for the user only. */
  list: {
    params:
      | { project: string; accountId?: string | null }
      | { project: null; deleted: boolean; accountId?: string | null }
    result: ArtifactListing[]
  }
  /** The artifact with one of its versions, the latest when `version` is null, and its files. */
  get: {
    params: {
      id: string
      version: number | null
      project: string | null
      accountId?: string | null
    }
    result: {
      artifact: ArtifactRecord
      version: VersionRecord
      files: StoredFile[]
      /** The version's type and format; null for a plain artifact. */
      type: ArtifactTypeInfo | null
    }
  }
  /** Newest first. */
  versions: {
    params: { id: string; project: string | null; accountId?: string | null }
    result: VersionRecord[]
  }
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
      /** What the version declares; nothing at the current runtime when absent. */
      declaration?: Declaration
      /** Made from a type, whose content the caller checked. */
      type?: ArtifactTypeInfo | null
      /** The Kettu account id owning this artifact, or null when created while signed out. */
      ownerAccountId?: string | null
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
      accountId?: string | null
      baseVersion: number
      changes: FileChange[]
      pages: number
      author: string | null
      note: string | null
      at: number
      /** What the version declares; the base version's when absent. */
      declaration?: Declaration
      /** The new version's type and format: a typed artifact's must name its type, a plain one none. */
      type?: ArtifactTypeInfo | null
      /** Paths written from the latest version's state, such as merged canvas operations, which no base check refuses. */
      unchecked?: string[]
    }
    result: { version: number }
  }
  /** `version` again as the newest, sharing its files. */
  restore: {
    params: {
      id: string
      project: string | null
      accountId?: string | null
      version: number
      baseVersion: number
      author: string | null
      note: string | null
      at: number
    }
    result: { version: number }
  }
  rename: {
    params: { id: string; project: string | null; accountId?: string | null; title: string }
    result: null
  }
  /** Into Recently deleted; an artifact there keeps the time it went, and `changed` is false. */
  delete: {
    params: { id: string; project: string | null; accountId?: string | null; at: number }
    result: { deletedAt: number; changed: boolean }
  }
  /** Back from Recently deleted; false when it was not there. */
  undelete: { params: { id: string; accountId?: string | null }; result: { changed: boolean } }
  /** Removes an artifact in Recently deleted for good, with the files no other version names. */
  erase: { params: { id: string; accountId?: string | null }; result: null }
  /** Removes what was deleted before `before`, then every file no version names. */
  purge: { params: { before: number }; result: { artifacts: number; files: number } }
  /** The artifact's comment threads, oldest first. */
  threads: {
    params: { id: string; project: string | null; accountId?: string | null }
    result: CommentThread[]
  }
  /** A new thread with its first comment. */
  addThread: {
    params: {
      id: string
      project: string | null
      accountId?: string | null
      threadId: string
      anchor: CommentAnchor
      author: CommentAuthor
      body: string
      at: number
    }
    result: CommentThread
  }
  reply: {
    params: {
      id: string
      project: string | null
      accountId?: string | null
      threadId: string
      author: CommentAuthor
      body: string
      at: number
    }
    result: CommentThread
  }
  resolve: {
    params: {
      id: string
      project: string | null
      accountId?: string | null
      threadId: string
      resolved: boolean
      at: number
    }
    result: CommentThread
  }
  /** Permanently deletes one comment thread and its comments. */
  deleteThread: {
    params: { id: string; project: string | null; accountId?: string | null; threadId: string }
    result: null
  }
  /** The owner had `version` open in a viewer; the newer of it and the record, up to the latest. */
  see: {
    params: { id: string; version: number; accountId?: string | null }
    result: { seen: number | null; changed: boolean }
  }
  /** The user sent the threads to a session. */
  markSent: {
    params: {
      id: string
      threadIds: string[]
      sessionId: string
      at: number
      accountId?: string | null
    }
    result: null
  }
  /** Anchors found again in a later version, in place of the threads' old ones. */
  reanchor: {
    params: {
      id: string
      anchors: { threadId: string; anchor: CommentAnchor }[]
      accountId?: string | null
    }
    result: null
  }
  /** Assigns reliable Kettu account ownership to unowned artifacts without overwriting existing owners. */
  claimOwners: {
    params: { owners: { id: string; accountId: string }[] }
    result: { changed: number }
  }
  /** Opaque ids of artifacts owned by another account and hidden from `accountId`. */
  hiddenIds: {
    params: { accountId: string | null }
    result: string[]
  }
  /** Every artifact in storage with its owner, for main's sharing reconcile without leaking across accounts. */
  briefs: {
    params: Record<string, never>
    result: ArtifactBrief[]
  }
}

export type ArtifactCallName = keyof ArtifactCalls

export type ArtifactCall = {
  [K in ArtifactCallName]: { name: K; params: ArtifactCalls[K]['params'] }
}[ArtifactCallName]
