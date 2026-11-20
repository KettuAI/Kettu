import type { DatabaseSync } from 'node:sqlite'

/**
 * Runs `run` in one transaction, rolled back when it throws. It never reads `db.isTransaction`,
 * which Node has only from 22.16.
 */
export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // SQLite ends the transaction itself after some errors, such as a full disk; the first error matters.
    }
    throw error
  }
}
