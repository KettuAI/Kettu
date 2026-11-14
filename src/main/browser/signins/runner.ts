// Starts the sign-ins worker for each request and ends it once answered, so nothing of the user's
// browsers stays in memory between requests.

import { Worker } from 'node:worker_threads'
import workerPath from './worker?modulePath'
import type { WorkerReply, WorkerRequest } from './protocol'
import type { ReaderEnv } from './reader'

// Long enough for the user to read macOS's prompt and type their password.
const READ_TIMEOUT_MS = 5 * 60 * 1000
const LIST_TIMEOUT_MS = 60 * 1000
// How long a cancelled read has to stop the keychain prompt before its thread is ended.
const CANCEL_GRACE_MS = 2_000

export class SignInWorkers {
  /** The reads under way, each with what cancels it. */
  private readonly reads = new Map<Worker, () => void>()

  constructor(
    private readonly env: ReaderEnv,
    /** Development only: the Safe Storage passwords in a file instead of the keychain. */
    private readonly keyFile: string | null,
  ) {}

  run(request: Exclude<WorkerRequest, { op: 'cancel' }>): Promise<unknown> {
    const worker = new Worker(workerPath, { workerData: { env: this.env, keyFile: this.keyFile } })
    const read = request.op === 'read'
    return new Promise<unknown>((resolve, reject) => {
      let done = false
      const finish = (settle: () => void) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.reads.delete(worker)
        // A grace period lets a cancelled read kill the prompt's process before the thread goes.
        setTimeout(() => void worker.terminate(), read ? CANCEL_GRACE_MS : 0)
        settle()
      }
      // Settled at once, so nothing it reads after is written; the worker still gets the grace
      // period to end the prompt's process.
      const cancel = () => {
        worker.postMessage({ op: 'cancel' } satisfies WorkerRequest)
        finish(() => reject(new Error('cancelled')))
      }
      if (read) this.reads.set(worker, cancel)
      const timer = setTimeout(
        () => {
          if (read) cancel()
          else finish(() => reject(new Error('Reading the browsers took too long')))
        },
        read ? READ_TIMEOUT_MS : LIST_TIMEOUT_MS,
      )
      worker.on('message', (reply: WorkerReply) =>
        finish(() => (reply.ok ? resolve(reply.value) : reject(new Error(reply.error)))),
      )
      // Kept after the answer too: an error event nobody listens to would take main down.
      worker.on('error', (error) => finish(() => reject(error)))
      worker.on('exit', (code) =>
        finish(() => reject(new Error(`The sign-ins worker stopped with code ${code}`))),
      )
      worker.postMessage(request)
    })
  }

  /** Stops the reads under way; they answer `cancelled` and nothing they read is used. */
  cancel(): void {
    for (const cancel of this.reads.values()) cancel()
  }
}
