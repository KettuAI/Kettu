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
 * A stored thread whose latest page is the whole of it and holds only OverBench's own notices:
 * no message of the user's and nothing from the agent.
 */
export function holdsNothing(page: ThreadPage): boolean {
  return page.older === null && page.entries.every((entry) => entry.kind === 'notice')
}
