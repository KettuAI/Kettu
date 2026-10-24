// Artifacts, as the agent host serves them to the interface. See docs/design/artifacts.md.

/** `art_` and a ULID: 26 characters of Crockford's base32, the first ten the creation time. */
export const ARTIFACT_ID = /^art_[0-9A-HJKMNP-TV-Z]{26}$/

export const ARTIFACT_TITLE_CHARS = 120

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

/**
 * The state an `artifacts.*` request that fails with `conflict` found, as its error's data: the
 * latest version, and whether the artifact is in Recently deleted.
 */
export interface ArtifactState {
  version: number
  deleted: boolean
}
