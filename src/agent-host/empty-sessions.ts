// What makes a session one with no message, for the one-time removal of the sessions New
// sub-session left in the index before it opened New session.

import type { SessionRecord } from './storage'
import type { ThreadPage } from './threads/model'

/**
 * A session that may hold no message: started by the user, with no title from the agent, from a
 * first message or of the user's own (`customTitle`), and nothing queued.
 */
export function mayBeEmpty(record: SessionRecord): boolean {
  return (
    record.origin === 'user' &&
    record.acpSessionId !== '' &&
    record.title === null &&
    record.customTitle === undefined &&
    !record.queue?.length
  )
}

/**
 * A stored thread with no entries at all: the latest page of one with any holds at least one.
 * Even a notice keeps the session, since the agent sends notices of its own and one from
 * `session/resume` says the agent holds history OverBench did not store.
 */
export function holdsNothing(page: ThreadPage): boolean {
  return page.entries.length === 0
}
