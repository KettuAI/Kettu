import { afterEach, expect, it, vi } from 'vitest'
import { startTestHost, type TestHost } from '../testing/harness'
import { inThreadWorker } from '../testing/thread-worker'
import type { ThreadReply } from './protocol'
import type { ThreadWorker } from './store'

let host: TestHost | null = null

afterEach(async () => {
  await host?.stop()
  host = null
})

interface Write {
  replace: boolean
  ok: boolean
}

/** The worker, with every write refused as a full disk refuses it while `full` says so. */
function refusingWrites(worker: ThreadWorker, full: () => boolean, writes: Write[]): ThreadWorker {
  let listener: ((reply: ThreadReply) => void) | null = null
  worker.onMessage((reply) => listener?.(reply))
  return {
    ...worker,
    onMessage: (next) => {
      listener = next
    },
    postMessage: (request) => {
      if (request.op === 'write') {
        const ok = !full()
        writes.push({ replace: request.change.replace === true, ok })
        if (!ok) {
          const { id } = request
          setImmediate(() =>
            listener?.({ type: 'error', id, message: 'database or disk is full', code: 'full' }),
          )
          return
        }
      }
      worker.postMessage(request)
    },
  }
}

it('waits longer after each failed write, and says once that the disk is full', async () => {
  let full = false
  const writes: Write[] = []
  host = await startTestHost({
    sessionTimings: { checkpointMs: 10 },
    threadWorker: (data) => refusingWrites(inThreadWorker(data), () => full, writes),
  })
  const port = host.connect()
  const { id } = await port.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await port.open(id)
  await port.untilStatus(id, 'ready')
  full = true
  const from = writes.length
  await port.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: '/long-stream --rate 100 --size 200000' }],
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  const refused = writes.slice(from)
  // A checkpoint every 10 ms of the stream would be about 60 writes.
  expect(refused.length).toBeGreaterThan(0)
  expect(refused.length).toBeLessThan(8)
  // Nothing of the failed writes was stored, so each tries the same entries again, not all.
  expect(refused.some((write) => write.replace)).toBe(false)
  const notices = port
    .entries(id)
    .filter((entry) => entry.kind === 'notice' && entry.severity === 'error')
  expect(notices).toHaveLength(1)
  full = false
  await vi.waitFor(() => expect(writes.at(-1)?.ok).toBe(true), { timeout: 5_000 })
  await port.request('sessions.cancel', { sessionId: id })
})
