// Messages between the thread store in the host and the thread worker that owns the database.

import type { ThreadWrite } from './model'

/**
 * How the database opened: as it was, new, recovered from corruption (the old file moved aside),
 * left alone because a newer app wrote it, or not at all.
 */
export type ThreadDbStatus = 'ok' | 'created' | 'recovered' | 'newer' | 'unavailable'

/**
 * `corrupt`: the file was damaged and is replaced by an empty one, so every thread is gone.
 * `conflict`: a write does not fit what is stored and changed nothing; write the thread whole.
 * `unavailable`: the database is not open, or the store has closed.
 */
export type ThreadErrorCode = 'corrupt' | 'conflict' | 'unavailable'

export type ThreadRequest =
  | { id: number; op: 'page'; sessionId: string; before: number | null }
  | { id: number; op: 'tail'; sessionId: string; from: number }
  | { id: number; op: 'load'; sessionId: string }
  | { id: number; op: 'write'; sessionId: string; change: ThreadWrite }
  | { id: number; op: 'remove'; sessionIds: string[] }
  | { id: number; op: 'blob'; sessionId: string; hash: string }
  | { id: number; op: 'close' }

export type ThreadReply =
  | { type: 'ready'; status: ThreadDbStatus }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number; message: string; code: ThreadErrorCode | null }
