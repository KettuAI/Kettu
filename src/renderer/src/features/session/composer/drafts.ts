import {
  browserAnnotationKey,
  isBrowserElementAnnotation,
  MAX_BROWSER_ANNOTATIONS,
  type BrowserElementAnnotation,
} from '@shared/browser'
import { PLUGIN_REF_LIMITS, type PluginMentionRef } from '@shared/plugin-refs'
import { isAgentId, isAttachment, type AgentId, type Attachment } from '@shared/thread'
import { removeKey } from '@renderer/lib/storage'

// Unsent composer text, attachments, attached artifact references, browser element references,
// passage comments, delegated agent recipient, and the items mentioned from plugins per session,
// in localStorage under `draft:<sessionId>` as JSON, written 300 ms after the last change.
// One stored as plain text, before drafts had attachments, reads as text alone, and older drafts
// default missing fields to empty/null. A draft that is too large or fails to save stays in memory.

/** The New session screen's draft, kept like a session's until the session it starts exists. */
export const NEW_SESSION_DRAFT = 'new'

/** Selected target agent for manually delegating the composer's task into a child session. */
export interface DelegateTarget {
  agentId: AgentId
  name: string
  /** Another host that owns the agent; omitted for this computer. */
  hostId?: string
}

/** The artifact kind badge shown on an attached artifact chip and reference block. */
export type AttachedArtifactKind = 'document' | 'slides' | 'web' | 'canvas'

/** A project artifact attached to a composer draft as a lightweight reference. */
export interface AttachedArtifact {
  id: string
  title: string
  kind: AttachedArtifactKind
  /** Another host that holds the artifact; omitted for this computer. */
  hostId?: string
}

/**
 * A draft's attachment as stored: the host's record of it, and what the tile shows about it;
 * `hostId` names another host that holds the record.
 */
export interface SavedAttachment {
  attachment: Attachment
  pixels: { width: number; height: number } | null
  scaled: { width: number; height: number } | null
  hostId?: string
}

/**
 * A comment on a passage of an agent message, waiting in the composer: `start` and `end` are the
 * passage's offsets in the text of the message `entryId`, which mark it in the thread again.
 */
export interface DraftComment {
  id: string
  entryId: string
  passage: string
  start: number
  end: number
  comment: string
}

interface Draft {
  text: string
  attachments: SavedAttachment[]
  comments: DraftComment[]
  mentions: PluginMentionRef[]
  artifacts: AttachedArtifact[]
  browserAnnotations: BrowserElementAnnotation[]
  delegateTarget: DelegateTarget | null
}

const WRITE_DELAY_MS = 300
const MAX_DRAFT_BYTES = 1024 * 1024

const memory = new Map<string, Draft>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

const PREFIX = 'draft:'
const key = (sessionId: string) => `${PREFIX}${sessionId}`
const EMPTY: Draft = {
  text: '',
  attachments: [],
  comments: [],
  mentions: [],
  artifacts: [],
  browserAnnotations: [],
  delegateTarget: null,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSize = (value: unknown): value is { width: number; height: number } | null =>
  value === null ||
  (isRecord(value) && typeof value.width === 'number' && typeof value.height === 'number')

function isSaved(value: unknown): value is SavedAttachment {
  return (
    isRecord(value) &&
    isAttachment(value.attachment) &&
    isSize(value.pixels) &&
    isSize(value.scaled) &&
    (value.hostId === undefined || typeof value.hostId === 'string')
  )
}

function isComment(value: unknown): value is DraftComment {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.entryId === 'string' &&
    typeof value.passage === 'string' &&
    typeof value.start === 'number' &&
    typeof value.end === 'number' &&
    typeof value.comment === 'string'
  )
}

function isMention(value: unknown): value is PluginMentionRef {
  return (
    isRecord(value) &&
    typeof value.pluginId === 'string' &&
    typeof value.source === 'string' &&
    typeof value.item === 'string' &&
    typeof value.word === 'string' &&
    typeof value.name === 'string'
  )
}

const ARTIFACT_KINDS: ReadonlySet<string> = new Set(['document', 'slides', 'web', 'canvas'])

function isAttachedArtifact(value: unknown): value is AttachedArtifact {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.title === 'string' &&
    typeof value.kind === 'string' &&
    ARTIFACT_KINDS.has(value.kind) &&
    (value.hostId === undefined || typeof value.hostId === 'string')
  )
}

function isDelegateTarget(value: unknown): value is DelegateTarget {
  return (
    isRecord(value) &&
    isAgentId(value.agentId) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    (value.hostId === undefined || typeof value.hostId === 'string')
  )
}

/** A stored draft; one stored as plain text, or that is not a draft's JSON, is text alone. */
export function parseDraft(raw: string): Draft {
  if (raw.startsWith('{')) {
    try {
      const value: unknown = JSON.parse(raw)
      if (isRecord(value) && typeof value.text === 'string' && Array.isArray(value.attachments)) {
        const comments = Array.isArray(value.comments) ? value.comments.filter(isComment) : []
        const mentions = Array.isArray(value.mentions)
          ? value.mentions.filter(isMention).slice(0, PLUGIN_REF_LIMITS.perMessage)
          : []
        const seenArtifacts = new Set<string>()
        const artifacts = Array.isArray(value.artifacts)
          ? value.artifacts.filter((item): item is AttachedArtifact => {
              if (!isAttachedArtifact(item) || seenArtifacts.has(item.id)) return false
              seenArtifacts.add(item.id)
              return true
            })
          : []
        const seenAnnotations = new Set<string>()
        const browserAnnotations = Array.isArray(value.browserAnnotations)
          ? value.browserAnnotations
              .filter((item): item is BrowserElementAnnotation => {
                if (!isBrowserElementAnnotation(item)) return false
                const dedupeKey = browserAnnotationKey(item)
                if (seenAnnotations.has(dedupeKey)) return false
                seenAnnotations.add(dedupeKey)
                return true
              })
              .slice(0, MAX_BROWSER_ANNOTATIONS)
          : []
        const delegateTarget = isDelegateTarget(value.delegateTarget) ? value.delegateTarget : null
        return {
          text: value.text,
          attachments: value.attachments.filter(isSaved),
          comments,
          mentions,
          artifacts,
          browserAnnotations,
          delegateTarget,
        }
      }
    } catch {
      // Text that only starts like JSON.
    }
  }
  return {
    text: raw,
    attachments: [],
    comments: [],
    mentions: [],
    artifacts: [],
    browserAnnotations: [],
    delegateTarget: null,
  }
}

function read(sessionId: string): Draft {
  const kept = memory.get(sessionId)
  if (kept) return kept
  try {
    const raw = localStorage.getItem(key(sessionId))
    return raw === null ? EMPTY : parseDraft(raw)
  } catch {
    return EMPTY
  }
}

export function readDraft(sessionId: string): string {
  return read(sessionId).text
}

export function readDraftAttachments(sessionId: string): SavedAttachment[] {
  return read(sessionId).attachments
}

export function readDraftComments(sessionId: string): DraftComment[] {
  return read(sessionId).comments
}

export function readDraftMentions(sessionId: string): PluginMentionRef[] {
  return read(sessionId).mentions
}

export function readDraftArtifacts(sessionId: string): AttachedArtifact[] {
  return read(sessionId).artifacts
}

export function readDraftBrowserAnnotations(sessionId: string): BrowserElementAnnotation[] {
  return read(sessionId).browserAnnotations
}

export function readDraftDelegateTarget(sessionId: string): DelegateTarget | null {
  return read(sessionId).delegateTarget
}

/**
 * Whether a draft holds what Send takes: text other than white space, an attachment, an artifact,
 * or a browser element reference.
 */
export function hasMessage(
  text: string,
  attachments: readonly unknown[],
  artifacts: readonly unknown[] = [],
  browserAnnotations: readonly unknown[] = [],
): boolean {
  return (
    text.trim().length > 0 ||
    attachments.length > 0 ||
    artifacts.length > 0 ||
    browserAnnotations.length > 0
  )
}

function write(sessionId: string, draft: Draft): void {
  memory.set(sessionId, draft)
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.set(
    sessionId,
    setTimeout(() => flushDraft(sessionId), WRITE_DELAY_MS),
  )
}

export function writeDraft(sessionId: string, text: string): void {
  write(sessionId, { ...read(sessionId), text })
}

export function writeDraftAttachments(sessionId: string, attachments: SavedAttachment[]): void {
  write(sessionId, { ...read(sessionId), attachments })
}

export function writeDraftComments(sessionId: string, comments: DraftComment[]): void {
  write(sessionId, { ...read(sessionId), comments })
}

export function writeDraftMentions(sessionId: string, mentions: PluginMentionRef[]): void {
  write(sessionId, { ...read(sessionId), mentions })
}

export function writeDraftArtifacts(sessionId: string, artifacts: AttachedArtifact[]): void {
  write(sessionId, { ...read(sessionId), artifacts })
}

export function writeDraftBrowserAnnotations(
  sessionId: string,
  browserAnnotations: BrowserElementAnnotation[],
): void {
  write(sessionId, { ...read(sessionId), browserAnnotations })
}

export function writeDraftDelegateTarget(
  sessionId: string,
  delegateTarget: DelegateTarget | null,
): void {
  write(sessionId, { ...read(sessionId), delegateTarget })
}

/** Writes a pending draft now, for example when the composer unmounts. */
export function flushDraft(sessionId: string): void {
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.delete(sessionId)
  const draft = memory.get(sessionId)
  if (draft === undefined) return
  if (
    !draft.text &&
    draft.attachments.length === 0 &&
    draft.comments.length === 0 &&
    draft.artifacts.length === 0 &&
    draft.browserAnnotations.length === 0 &&
    draft.delegateTarget === null
  ) {
    removeKey(key(sessionId))
    memory.delete(sessionId)
    return
  }
  const value = JSON.stringify(draft)
  if (value.length * 2 > MAX_DRAFT_BYTES) {
    console.warn(`Draft for ${sessionId} is over 1 MB; keeping it in memory only`)
    return
  }
  try {
    localStorage.setItem(key(sessionId), value)
    memory.delete(sessionId)
  } catch (error) {
    console.warn(`Could not save the draft for ${sessionId}; keeping it in memory`, error)
  }
}

/** Every draft, saved or in memory, New session's included. */
export function draftIds(): string[] {
  const ids = new Set(memory.keys())
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i)
      if (name?.startsWith(PREFIX)) ids.add(name.slice(PREFIX.length))
    }
  } catch {
    // Without storage only the drafts in memory count.
  }
  return [...ids].sort()
}

/**
 * The sessions whose draft, saved or in memory, holds text, an attachment, a comment, an artifact,
 * or a browser element reference.
 */
export function draftedSessions(): string[] {
  return draftIds().filter((id) => {
    if (id === NEW_SESSION_DRAFT) return false
    const draft = read(id)
    return (
      draft.text.trim() !== '' ||
      draft.attachments.length > 0 ||
      draft.comments.length > 0 ||
      draft.artifacts.length > 0 ||
      draft.browserAnnotations.length > 0
    )
  })
}

export function clearDraft(sessionId: string): void {
  const timer = timers.get(sessionId)
  if (timer) clearTimeout(timer)
  timers.delete(sessionId)
  memory.delete(sessionId)
  removeKey(key(sessionId))
}
