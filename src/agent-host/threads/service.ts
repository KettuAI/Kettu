// The thread worker's work, apart from the worker itself so tests can run it in their own thread.

import type { ArtifactCall } from '../artifacts/model'
import { ThreadDb, ThreadDbError } from './db'
import type { ThreadReply, ThreadRequest, ThreadWorkerData } from './protocol'

/**
 * Opens the database at `file`, reports how with a `ready` reply, and returns the handler that
 * answers each request in the order it arrives.
 */
export function startThreadService(
  { file, contentDir }: ThreadWorkerData,
  reply: (message: ThreadReply) => void,
  now?: () => number,
): (request: ThreadRequest) => void {
  const log = (level: 'info' | 'warn' | 'error', message: string): void =>
    reply({ type: 'log', level, message })
  let db: ThreadDb | null = null
  try {
    db = ThreadDb.open(file, log, now, contentDir)
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
      const known = error instanceof ThreadDbError ? error : null
      reply({
        type: 'error',
        id: request.id,
        message: (error as Error).message,
        code: known?.code ?? null,
        ...(known?.data ? { data: known.data } : {}),
      })
    }
  }
}

function run(db: ThreadDb, request: ThreadRequest): unknown {
  switch (request.op) {
    case 'page':
      return db.page(request.sessionId, request.before, request.from)
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
    case 'blob':
      return db.blob(request.sessionId, request.hash)
    case 'mentions':
      return db.mentions(request.sessionId, request.text)
    case 'outline':
      return db.outline(request.sessionId)
    case 'setOutlineTitles':
      return db.setOutlineTitles(request.sessionId, request.titles)
    case 'routine':
      return db.routine(request.call)
    case 'artifact':
      return artifact(db, request.call)
    case 'close':
      db.close()
      return null
  }
}

function artifact(db: ThreadDb, call: ArtifactCall): unknown {
  switch (call.name) {
    case 'list':
      return db.listArtifacts(call.params)
    case 'get':
      return db.getArtifact(call.params)
    case 'versions':
      return db.artifactVersions(call.params)
    case 'create':
      return db.createArtifact(call.params)
    case 'write':
      return db.writeArtifact(call.params)
    case 'restore':
      return db.restoreArtifact(call.params)
    case 'rename':
      db.renameArtifact(call.params)
      return null
    case 'delete':
      return db.deleteArtifact(call.params)
    case 'undelete':
      return db.undeleteArtifact(call.params.id)
    case 'erase':
      db.eraseArtifact(call.params.id)
      return null
    case 'purge':
      return db.purgeArtifacts(call.params.before)
  }
}
