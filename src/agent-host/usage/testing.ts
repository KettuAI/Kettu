// An in-memory scan context for the readers' tests, keeping rows the way the database does.

import type { Platform } from '@shared/platform'
import type { FileCursor, ScanContext, UsageRow } from './model'
import { keepsNewer } from './rows'

export interface MemoryContext extends ScanContext {
  readonly rows: Map<string, UsageRow>
  readonly cursors: Map<string, FileCursor>
  readonly logs: { level: string; message: string }[]
  readonly planned: { files: number; bytes: number }
  readonly doneBytes: number
}

export function memoryContext(
  options: {
    env?: Record<string, string | undefined>
    home?: string
    platform?: Platform
    signal?: AbortSignal
  } = {},
): MemoryContext {
  const rows = new Map<string, UsageRow>()
  const cursors = new Map<string, FileCursor>()
  const logs: { level: string; message: string }[] = []
  const planned = { files: 0, bytes: 0 }
  let doneBytes = 0
  return {
    env: options.env ?? {},
    home: options.home ?? '/home/test',
    platform: options.platform ?? 'darwin',
    signal: options.signal ?? new AbortController().signal,
    rows,
    cursors,
    logs,
    planned,
    get doneBytes() {
      return doneBytes
    },
    cursor: (id) => cursors.get(id) ?? null,
    commit(next, cursor) {
      for (const row of next) {
        const stored = rows.get(row.key)
        if (!stored || keepsNewer(stored, row)) rows.set(row.key, row)
      }
      cursors.set(cursor.id, cursor)
    },
    plan(files, bytes) {
      planned.files += files
      planned.bytes += bytes
    },
    done(bytes) {
      doneBytes += bytes
    },
    log: (level, message) => logs.push({ level, message }),
  }
}
