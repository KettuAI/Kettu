// Entry of the usage worker, a worker_threads thread of the agent host that owns the usage
// database and reads the agents' logs. Main builds it with `?modulePath` and passes its path in
// `host:init`.

import { parentPort, workerData } from 'node:worker_threads'
import type { UsageRequest } from './protocol'
import { LOG_READERS } from './readers'
import { startUsageService } from './service'

const port = parentPort!
const handle = startUsageService((workerData as { file: string }).file, LOG_READERS, (reply) =>
  port.postMessage(reply),
)
port.on('message', (request: UsageRequest) => handle(request))
