// The thread worker's work, apart from the worker itself so tests can run it in their own thread.

import { ThreadDb, ThreadDbError } from './db'
import type { ThreadReply, ThreadRequest } from './protocol'

/**
 * Opens the database at `file`, reports how with a `ready` reply, and returns the handler that
 * answers each request in the order it arrives.
 */
export function startThreadService(
  file: string,
  reply: (message: ThreadReply) => void,
  now?: () => number,
): (request: ThreadRequest) => void {
  const log = (level: 'info' | 'warn' | 'error', message: string): void =>
    reply({ type: 'log', level, message })
  let db: ThreadDb | null = null
  try {
    db = ThreadDb.open(file, log, now)
    reply({ type: 'ready', status: db.status })
  } catch (error) {
    log('error', `Could not open the thread database: ${(error as Error).message}`)
    reply({ type: 'ready', status: 'unavailable' })
  }
  return (request) => {
    if (!db) {
      reply({
        type: 'error',
        id: request.id,
        message: 'The thread database is not open',
        code: 'unavailable',
      })
      return
    }
    try {
      reply({ type: 'result', id: request.id, value: run(db, request) })
    } catch (error) {
      reply({
        type: 'error',
        id: request.id,
        message: (error as Error).message,
        code: error instanceof ThreadDbError ? error.code : null,
      })
    }
  }
}

function run(db: ThreadDb, request: ThreadRequest): unknown {
  switch (request.op) {
    case 'page':
      return db.page(request.sessionId, request.before)
    case 'tail':
      return db.tail(request.sessionId, request.from)
    case 'load':
      return db.load(request.sessionId)
    case 'write':
      db.write(request.sessionId, request.change)
      return null
    case 'remove':
      db.remove(request.sessionIds)
      return null
    case 'close':
      db.close()
      return null
  }
}
