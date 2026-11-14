// Entry of the sign-ins worker, a worker_threads thread of main that reads the user's browsers
// off main's event loop. Main builds it with `?modulePath`, starts one for each request and ends
// it once answered. Cookie values go back to main alone, which writes them into Kettu's browser.

import { parentPort, workerData } from 'node:worker_threads'
import { fileKeySource, keychainKeySource } from './keychain'
import { listSites, listSources, readCookies, siteIndex, type ReaderEnv } from './reader'
import type { WorkerReply, WorkerRequest } from './protocol'

const { env, keyFile } = workerData as { env: ReaderEnv; keyFile: string | null }
const keys = keyFile ? fileKeySource(keyFile) : keychainKeySource
const port = parentPort!
const cancel = new AbortController()

async function run(request: Exclude<WorkerRequest, { op: 'cancel' }>): Promise<unknown> {
  const now = Date.now()
  switch (request.op) {
    case 'sources':
      return listSources(env, now)
    case 'sites':
      return listSites(env, request.choice, now)
    case 'index':
      return siteIndex(env, now)
    case 'read':
      return readCookies(env, request.request, keys, cancel.signal)
  }
}

port.on('message', (request: WorkerRequest) => {
  if (request.op === 'cancel') {
    cancel.abort()
    return
  }
  run(request).then(
    (value) => port.postMessage({ ok: true, value } satisfies WorkerReply),
    (error: unknown) =>
      port.postMessage({
        ok: false,
        error: cancel.signal.aborted ? 'cancelled' : (error as Error).message,
      } satisfies WorkerReply),
  )
})
