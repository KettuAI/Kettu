// Messages between the thread store in the host and the thread worker that owns the database.

import type { OutlineTitle } from '@shared/agent-host'
import type { ArtifactState } from '@shared/artifacts'
import type { ArtifactCall } from '../artifacts/model'
import type { RuntimeCall } from '../artifacts/runtime/calls'
import type { RoutineCall } from '../routines/calls'
import type { ImageMode, ThreadWrite } from './model'

/**
 * What the worker is started with: the database, and the folder of the artifacts' HTML. A
 * `reader` only reads the pages, outlines and bytes of threads, beside the worker that writes.
 */
export interface ThreadWorkerData {
  file: string
  contentDir: string | null
  reader?: boolean
}

/**
 * How the database opened: as it was, new, recovered from corruption (the old file moved aside),
 * left alone because a newer app wrote it, or not at all.
 */
export type ThreadDbStatus = 'ok' | 'created' | 'recovered' | 'newer' | 'unavailable'

/**
 * `corrupt`: the file was damaged and is replaced by an empty one, so every thread is gone.
 * `conflict`: a write does not fit what is stored and changed nothing; write the thread whole.
 * For an artifact, it is not in the state the call assumed, which the error's data gives.
 * `unavailable`: the database is not open, or the store has closed.
 * `not_found`, `deleted`: no such artifact or version in reach, or the artifact is in Recently
 * deleted.
 * `invalid`, `too_large`: a write of an artifact's data that does not apply, or would not fit.
 * `full`: the disk has no room for the write, which changed nothing.
 */
export type ThreadErrorCode =
  | 'corrupt'
  | 'conflict'
  | 'unavailable'
  | 'not_found'
  | 'deleted'
  | 'invalid'
  | 'too_large'
  | 'full'

export type ThreadRequest =
  | {
      id: number
      op: 'page'
      sessionId: string
      before: number | null
      from: number | null
      images?: ImageMode
    }
  | { id: number; op: 'tail'; sessionId: string; from: number; images?: ImageMode }
  | { id: number; op: 'load'; sessionId: string }
  | { id: number; op: 'write'; sessionId: string; change: ThreadWrite }
  | { id: number; op: 'remove'; sessionIds: string[] }
  | { id: number; op: 'blob'; sessionId: string; hash: string }
  | { id: number; op: 'mentions'; sessionId: string; text: string }
  | { id: number; op: 'outline'; sessionId: string }
  | { id: number; op: 'setOutlineTitles'; sessionId: string; titles: OutlineTitle[] }
  | { id: number; op: 'artifact'; call: ArtifactCall }
  | { id: number; op: 'runtime'; call: RuntimeCall }
  | { id: number; op: 'routine'; call: RoutineCall }
  | { id: number; op: 'close' }

export type ThreadReply =
  | { type: 'ready'; status: ThreadDbStatus }
  // The database was damaged and replaced by an empty one, which a reader must open again.
  | { type: 'recovered' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'result'; id: number; value: unknown }
  | {
      type: 'error'
      id: number
      message: string
      code: ThreadErrorCode | null
      data?: ArtifactState
    }
