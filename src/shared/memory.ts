// Kettu's memory: what agents learned about the user and a project, kept by the host in two layers
// and handed to every agent the same way, whatever its harness.

import type { AgentId } from './agents'

/** Global memory is about the user and used in every session; project memory in its project's. */
export type MemoryLayer = 'global' | 'project'

/** Where an entry lives: the global layer, or a project's by the project's folder path. */
export type MemoryScope = { layer: 'global' } | { layer: 'project'; project: string }

/** Who last wrote an entry: an agent in a session, or the user when both are null. */
export interface MemorySource {
  agentId: AgentId | null
  sessionId: string | null
}

export interface MemoryEntry {
  /** Its file's name without `.md`; unique in its layer. */
  id: string
  title: string
  /** One line, the entry's line in the index every session is handed. */
  description: string
  body: string
  createdAt: number
  updatedAt: number
  source: MemorySource
}

/** What a write gives: the user's form, or an agent's call. */
export interface MemoryDraft {
  title: string
  description: string
  body: string
}

export const MEMORY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MEMORY_TITLE_CHARS = 80
export const MEMORY_DESCRIPTION_CHARS = 200
export const MEMORY_BODY_CHARS = 8_000
export const MEMORY_ENTRIES_PER_LAYER = 300
/** Proposed global writes that may wait in one session's thread at once. */
export const MEMORY_PROPOSALS_WAITING = 3

/** What an agent's write did, as its thread shows it. */
export type MemoryAction = 'remember' | 'update' | 'forget'

/**
 * A project write is `written`, then `undone` if the user takes it back. A global write is only
 * proposed: `proposed` while its card waits, then `accepted` or `declined`.
 */
export type MemoryWriteStatus = 'written' | 'undone' | 'proposed' | 'accepted' | 'declined'

/** The user's answer to a proposed global write. */
export type MemoryDecision = 'remember' | 'skip'

/** A project Settings › Memory lists, with how many entries its memory holds. */
export interface MemoryProject {
  path: string
  name: string
  count: number
}

/** What Settings › Memory shows first. */
export interface MemoryOverview {
  enabled: boolean
  global: MemoryEntry[]
  projects: MemoryProject[]
  /** Entries in the agents' own memories, for projects Kettu knows, not imported yet. */
  importable: number
}

/** An entry an agent's own memory holds, as the import dialog lists it. */
export interface MemoryImportEntry {
  /** Names the entry in `memory.import`; opaque to clients. */
  key: string
  title: string
  description: string
  /** The harness filed it as being about the user, a candidate for global memory. */
  aboutUser: boolean
}

/** One agent's own memory of one project. */
export interface MemoryImportSource {
  agentId: AgentId
  agentName: string
  project: string
  projectName: string
  entries: MemoryImportEntry[]
}

export interface MemoryImportScan {
  sources: MemoryImportSource[]
}

export interface MemoryImportResult {
  imported: number
  /** Entries already in Kettu's memory with the same title and body. */
  skipped: number
  /** Of `imported`, those put in global memory. */
  global: number
}

/** Whether `value` is a scope as a client may send it; the host still checks the project. */
export function isMemoryScope(value: unknown): value is MemoryScope {
  if (typeof value !== 'object' || value === null) return false
  const scope = value as Record<string, unknown>
  if (scope.layer === 'global') return Object.keys(scope).length === 1
  return (
    scope.layer === 'project' &&
    typeof scope.project === 'string' &&
    scope.project.length > 0 &&
    Object.keys(scope).length === 2
  )
}
