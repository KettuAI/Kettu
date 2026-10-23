// Entry of the thread worker, a worker_threads thread of the agent host that owns the thread
// database. Main builds it with `?modulePath` and passes its path in `host:init`.

import { parentPort, workerData } from 'node:worker_threads'
import type { ThreadRequest, ThreadWorkerData } from './protocol'
import { startThreadService } from './service'

const port = parentPort!
const handle = startThreadService(workerData as ThreadWorkerData, (reply) =>
  port.postMessage(reply),
)
port.on('message', (request: ThreadRequest) => handle(request))
