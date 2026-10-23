// The thread service in the test's own thread, behind the worker interface: messages are cloned
// and delivered later, as between threads, but no bundled worker file is needed.

import type { ThreadReply, ThreadRequest, ThreadWorkerData } from '../threads/protocol'
import { startThreadService } from '../threads/service'
import type { ThreadWorker } from '../threads/store'

export function inThreadWorker(data: ThreadWorkerData): ThreadWorker {
  let onMessage: ((reply: ThreadReply) => void) | null = null
  let onExit: ((error: Error | null) => void) | null = null
  let handle: ((request: ThreadRequest) => void) | null = null
  let stopped = false
  const deliver = (reply: ThreadReply): void => {
    const copy = structuredClone(reply)
    setImmediate(() => {
      if (!stopped) onMessage?.(copy)
    })
  }
  // Started like a real worker: after the caller has attached its listeners.
  setImmediate(() => {
    if (!stopped) handle = startThreadService(data, deliver)
  })
  return {
    postMessage: (request) => {
      const copy = structuredClone(request)
      setImmediate(() => {
        if (!stopped) handle?.(copy)
      })
    },
    onMessage: (listener) => {
      onMessage = listener
    },
    onExit: (listener) => {
      onExit = listener
    },
    terminate: async () => {
      if (stopped) return
      stopped = true
      handle?.({ id: 0, op: 'close' })
      onExit?.(null)
    },
  }
}
