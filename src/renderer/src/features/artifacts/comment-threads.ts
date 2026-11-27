// Where a comment thread stands, as its card, its pin and its popover say it, and the pins a page
// shows for the threads.

import { isPending, type CommentAnchor, type CommentThread } from '@shared/artifact-comments'
import { DOCUMENT_ENTRY } from '@shared/artifact-document-anchors'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import type { Pin } from '@shared/artifact-runtime/page-messages'
import type { VersionSummary } from '@shared/artifacts'
import type { ShownVersion } from './use-artifact'

/** Where a thread stands, in the order a person reads them. */
export type ThreadState =
  | { kind: 'notSent' }
  | { kind: 'sent' }
  | { kind: 'needsReply' }
  | { kind: 'gone' }
  | { kind: 'resolved'; version: number | null }

/**
 * The version that was the latest when `at` came: the one a thread was resolved in. The host keeps
 * no such version, so it is derived from the host's own times alone, the thread's and the versions',
 * and reads the same on every client.
 */
export function versionAt(versions: readonly VersionSummary[] | null, at: number): number | null {
  if (!versions) return null
  return versions.find((v) => v.createdAt <= at)?.version ?? versions.at(-1)?.version ?? null
}

export function threadState(
  thread: CommentThread,
  versions: readonly VersionSummary[] | null,
): ThreadState {
  if (thread.resolvedAt !== null) {
    return { kind: 'resolved', version: versionAt(versions, thread.resolvedAt) }
  }
  if (thread.anchor.missing) return { kind: 'gone' }
  if (isPending(thread)) return { kind: 'notSent' }
  // An agent wrote last, and did not resolve it: it asks something back.
  if (thread.comments.at(-1)?.author.session != null) return { kind: 'needsReply' }
  return { kind: 'sent' }
}

/** Each thread's number, the same on its pin and its card: its place among them, oldest first. */
export function threadNumbers(threads: readonly CommentThread[]): Map<string, number> {
  return new Map(threads.map((thread, i) => [thread.id, i + 1]))
}

/** Open threads: the ones that ask something back first, then the newest. */
export function openOrder(threads: readonly CommentThread[]): CommentThread[] {
  const rank = (thread: CommentThread) => (threadState(thread, null).kind === 'needsReply' ? 0 : 1)
  const last = (thread: CommentThread) => thread.comments.at(-1)?.createdAt ?? 0
  return threads
    .filter((thread) => thread.resolvedAt === null)
    .toSorted((a, b) => rank(a) - rank(b) || last(b) - last(a))
}

/**
 * The pins each page of the version shows: open threads, and resolved ones too while the Resolved
 * tab is on, a thread whose element is gone waiting dashed on its page.
 */
export function pinsFor(
  threads: readonly CommentThread[] | null,
  shown: ShownVersion,
  options: { resolved: boolean; active: string | null },
): (page: number | null) => Pin[] {
  const all = threads ?? []
  const numbers = threadNumbers(all)
  const showing = all.filter((thread) =>
    options.resolved ? thread.resolvedAt !== null : thread.resolvedAt === null,
  )
  return (page) =>
    showing.flatMap((thread) => {
      const { anchor } = thread
      const canvasPage = page === null ? null : (shown.canvas?.pages[page] ?? null)
      if (page !== null && anchor.page?.number !== canvasPage?.number) return []
      // A frame shows its page's own file, or the entry page of an old canvas; an element of
      // another file pins its page.
      const file = canvasPage?.file ?? ARTIFACT_ENTRY
      const lost = anchor.missing || anchor.path !== file
      const pin: Pin = {
        n: numbers.get(thread.id) ?? 0,
        src: lost ? null : anchor.offset,
        answered: false,
      }
      if (thread.resolvedAt !== null) pin.kind = 'done'
      else if (anchor.missing) pin.kind = 'lost'
      if (thread.id === options.active) pin.active = true
      return [pin]
    })
}

/**
 * Which single-thread send action a row's menu offers: unsent open threads can be sent on their
 * own, and already-sent open threads (including legacy reopened rows) can be sent again.
 */
export function rowSendKind(
  thread: CommentThread,
  tab: 'open' | 'resolved',
): 'sendOnly' | 'sendAgain' | null {
  if (tab !== 'open' || thread.resolvedAt !== null) return null
  return isPending(thread) ? 'sendOnly' : 'sendAgain'
}

/** Action kinds shown in a CommentsCard row's overflow (`⋯`) menu, in display order. */
export type ThreadRowActionKind =
  'locate' | 'view' | 'sendOnly' | 'sendAgain' | 'resolve' | 'reopen' | 'delete'

/**
 * The overflow menu actions for one row in `CommentsCard`, aligned with its Open / Resolved state
 * and the host's capabilities.
 */
export function threadRowMenuKinds(
  thread: CommentThread,
  tab: 'open' | 'resolved',
  options: { canResolve: boolean; canDelete: boolean },
): ThreadRowActionKind[] {
  const actions: ThreadRowActionKind[] = []
  const canLocate =
    !thread.anchor.missing &&
    (thread.anchor.offset !== null || thread.anchor.page !== null || thread.anchor.tag !== null)
  actions.push(canLocate ? 'locate' : 'view')
  const send = rowSendKind(thread, tab)
  if (send) actions.push(send)
  if (options.canResolve) {
    if (tab === 'open' && thread.resolvedAt === null) actions.push('resolve')
    else if (tab === 'resolved' && thread.resolvedAt !== null) actions.push('reopen')
  }
  if (options.canDelete) actions.push('delete')
  return actions
}

/**
 * Finds an existing open, anchored thread on the same element as `anchor`:
 * - For source-anchored elements (`offset !== null`), matches exact `(path, page.number, offset)`
 *   so clicking a distinct child element still starts a new draft.
 * - For script-rendered or slide elements (`offset === null`), matches exact
 *   `(path, page.number, tag, text)`.
 * Prefers `preferredId` if it matches; otherwise returns the newest matching open thread.
 */
export function matchingOpenThread(
  threads: readonly CommentThread[],
  anchor: CommentAnchor,
  preferredId: string | null = null,
): CommentThread | null {
  const page = anchor.page?.number ?? null
  let fallback: CommentThread | null = null
  for (const thread of threads) {
    if (thread.resolvedAt !== null || thread.anchor.missing) continue
    if (thread.anchor.path !== anchor.path) continue
    if ((thread.anchor.page?.number ?? null) !== page) continue
    const sameElement =
      anchor.offset !== null
        ? thread.anchor.offset === anchor.offset
        : thread.anchor.offset === null &&
          thread.anchor.tag === anchor.tag &&
          (anchor.tag === null || thread.anchor.text === anchor.text)
    if (!sameElement) continue
    if (preferredId !== null && thread.id === preferredId) return thread
    fallback = thread
  }
  return fallback
}

/** Whether `DocumentSheet` renders a pin for `thread` and can open it inline under its block. */
export function canInlineDocThread(
  thread: CommentThread,
  options: { latest: boolean; commentsOpen: boolean },
): boolean {
  return (
    options.latest &&
    options.commentsOpen &&
    thread.resolvedAt === null &&
    thread.anchor.path === DOCUMENT_ENTRY &&
    thread.anchor.offset !== null &&
    !thread.anchor.missing
  )
}

/** Whether `DeckSheet` renders a pin for `thread` on its slide and can open it inline there. */
export function canInlineDeckThread(
  thread: CommentThread,
  options: { latest: boolean; commentsOpen: boolean; slideCount: number },
): boolean {
  const slide = thread.anchor.page?.number ?? null
  return (
    options.latest &&
    options.commentsOpen &&
    thread.resolvedAt === null &&
    thread.anchor.path === ARTIFACT_ENTRY &&
    slide !== null &&
    slide >= 1 &&
    slide <= options.slideCount
  )
}
