// What waits for the user in a session, read from the entries `sessions.requests` gives, as the
// menu bar panel and the notch island show it.

import type { ControlStep } from './control'
import type { PendingPermission, ThreadEntry, ToolEntry } from './thread'

/** What is shown of a tool: its kind, title, paths and command. */
export type PendingTool = Pick<
  ToolEntry,
  'toolKind' | 'title' | 'locations' | 'rawInput' | 'question'
>

/** A request in a session's thread that waits for the user. */
export type PendingRequest =
  | { kind: 'tool'; entryId: string; tool: PendingTool; permission: PendingPermission }
  | { kind: 'origin'; entryId: string; origin: string }
  | { kind: 'app'; entryId: string; app: string }
  | { kind: 'setup'; entryId: string }
  /** A step the agent asked the user to do on a surface, where it is when known. */
  | { kind: 'step'; entryId: string; step: ControlStep; target: string | null }
  /** Any other card that waits, which only the window answers: its entry's kind. */
  | { kind: 'other'; entryId: string; entry: ThreadEntry['kind'] }

/** One entry as a request, or null for one that no longer waits. */
export function pendingRequest(entry: ThreadEntry): PendingRequest | null {
  switch (entry.kind) {
    case 'tool':
      return entry.permission
        ? { kind: 'tool', entryId: entry.id, tool: entry, permission: entry.permission }
        : null
    case 'browser_origin':
      return entry.decision === null
        ? { kind: 'origin', entryId: entry.id, origin: entry.origin }
        : null
    case 'computer_app':
      return entry.decision === null ? { kind: 'app', entryId: entry.id, app: entry.appName } : null
    case 'computer_setup':
      return entry.outcome === null ? { kind: 'setup', entryId: entry.id } : null
    case 'control_ask':
      return entry.outcome === null
        ? { kind: 'step', entryId: entry.id, step: entry.step, target: entry.target }
        : null
    default:
      return { kind: 'other', entryId: entry.id, entry: entry.kind }
  }
}

/** The requests among a session's waiting entries, in thread order. */
export function pendingRequests(entries: readonly ThreadEntry[]): PendingRequest[] {
  return entries.flatMap((entry) => pendingRequest(entry) ?? [])
}
