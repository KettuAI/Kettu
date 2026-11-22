// Where a comment thread stands, as its card, its pin and its popover say it, and the pins a page
// shows for the threads.

import { isPending, type CommentThread } from '@shared/artifact-comments'
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
