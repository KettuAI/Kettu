// Detecting disk-full failures across Node.js filesystem errors, SQLite errors, and agent stderr.

const SQLITE_FULL = 13

const DISK_FULL_ERRNO: ReadonlySet<string> = new Set(['ENOSPC', 'EDQUOT'])

const DISK_FULL_PATTERNS: readonly RegExp[] = [
  /\bENOSPC\b/i,
  /\bEDQUOT\b/i,
  /\bSQLITE_FULL\b/i,
  /no space left on device/i,
  /not enough space on (?:the )?disk/i,
  /there is not enough space on the disk/i,
  /database or disk is full/i,
  /\bdisk(?:\s+is)?\s+full\b/i,
]

export interface StorageWriteOutcome {
  file: string
  ok: boolean
  error?: unknown
}

/** Whether a line or message reports that the disk or filesystem has run out of space. */
export function isDiskFullText(text: string): boolean {
  if (!text) return false
  return DISK_FULL_PATTERNS.some((pattern) => pattern.test(text))
}

/** Whether an error (or its causal chain) indicates ENOSPC / EDQUOT / SQLITE_FULL. */
export function isDiskFullError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth++) {
    if (typeof current === 'string') return isDiskFullText(current)
    if (typeof current !== 'object') return false
    const record = current as {
      code?: unknown
      errcode?: unknown
      name?: unknown
      message?: unknown
      cause?: unknown
    }
    if (typeof record.code === 'string' && DISK_FULL_ERRNO.has(record.code)) return true
    if (
      record.code === 'full' &&
      (record.name === 'ThreadStoreError' || record.name === 'ThreadDbError')
    ) {
      return true
    }
    if (typeof record.errcode === 'number' && (record.errcode & 0xff) === SQLITE_FULL) return true
    if (typeof record.message === 'string' && isDiskFullText(record.message)) return true
    if (record.cause === current) break
    current = record.cause
  }
  return false
}
