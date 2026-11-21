import { create } from 'zustand'
import {
  readDraftComments,
  writeDraftComments,
  type DraftComment,
} from '@renderer/features/session/composer/drafts'
import { useThreadsStore } from './threads'

// The comments on passages of agent messages that wait in a session's composer, in thread order,
// kept with the session's draft.

export type ReplyComment = DraftComment

interface ReplyCommentsStore {
  /** By session; a session not here has what its stored draft holds. */
  bySession: Record<string, ReplyComment[]>
  /** The comment whose row is pointed at, whose passage the thread marks more strongly. */
  hovered: string | null
}

export const useReplyCommentsStore = create<ReplyCommentsStore>()(() => ({
  bySession: {},
  hovered: null,
}))

// Read once per session, so a selector keeps returning the same list.
const stored = new Map<string, ReplyComment[]>()

function storedComments(sessionId: string): ReplyComment[] {
  let comments = stored.get(sessionId)
  if (!comments) {
    comments = readDraftComments(sessionId)
    stored.set(sessionId, comments)
  }
  return comments
}

export function commentsOf(sessionId: string): ReplyComment[] {
  return useReplyCommentsStore.getState().bySession[sessionId] ?? storedComments(sessionId)
}

export function useReplyComments(sessionId: string): ReplyComment[] {
  return useReplyCommentsStore((s) => s.bySession[sessionId] ?? storedComments(sessionId))
}

function setComments(sessionId: string, comments: ReplyComment[]): void {
  useReplyCommentsStore.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: comments } }))
  writeDraftComments(sessionId, comments)
}

/**
 * Puts the comment among the others in thread order: by message, then by where in it the passage
 * starts. A message no longer loaded lies in older pages, so before every loaded one.
 */
export function addComment(sessionId: string, comment: ReplyComment): void {
  const order = useThreadsStore.getState().replicas[sessionId]?.state?.order ?? []
  const at = order.indexOf(comment.entryId)
  const current = commentsOf(sessionId)
  const before = (other: ReplyComment): boolean => {
    const index = order.indexOf(other.entryId)
    return index < at || (index === at && other.start <= comment.start)
  }
  const next = current.findIndex((other) => !before(other))
  const place = next < 0 ? current.length : next
  setComments(sessionId, [...current.slice(0, place), comment, ...current.slice(place)])
}

export function editComment(sessionId: string, id: string, text: string): void {
  setComments(
    sessionId,
    commentsOf(sessionId).map((c) => (c.id === id ? { ...c, comment: text } : c)),
  )
}

/** Removes the comments `ids`, or every one without them. */
export function removeComments(sessionId: string, ids?: readonly string[]): void {
  const kept = ids ? commentsOf(sessionId).filter((c) => !ids.includes(c.id)) : []
  setComments(sessionId, kept)
  const hovered = hoveredId()
  if (hovered && !kept.some((c) => c.id === hovered)) hoverComment(null)
}

/** Writes the comments to the draft again, after a send emptied the draft and before it is done. */
export function keepComments(sessionId: string): void {
  const comments = commentsOf(sessionId)
  if (comments.length > 0) writeDraftComments(sessionId, comments)
}

const hoveredId = (): string | null => useReplyCommentsStore.getState().hovered

export function hoverComment(id: string | null): void {
  if (hoveredId() !== id) useReplyCommentsStore.setState({ hovered: id })
}
