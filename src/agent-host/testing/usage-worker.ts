// The usage service in the test's own thread, behind the worker interface, like
// `inThreadWorker`. It reads no logs unless a test passes readers.

import type { LogReader } from '../usage/model'
import type { UsageReply, UsageRequest } from '../usage/protocol'
import { startUsageService } from '../usage/service'
import type { UsageWorker } from '../usage/store'

export function inUsageWorker(file: string, readers: readonly LogReader[] = []): UsageWorker {
  let onMessage: ((reply: UsageReply) => void) | null = null
  let onExit: ((error: Error | null) => void) | null = null
  let handle: ((request: UsageRequest) => void) | null = null
  let stopped = false
  const deliver = (reply: UsageReply): void => {
    const copy = structuredClone(reply)
    setImmediate(() => {
      if (!stopped) onMessage?.(copy)
    })
  }
  // Started like a real worker: after the caller has attached its listeners.
  setImmediate(() => {
    if (!stopped) handle = startUsageService(file, readers, deliver)
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
