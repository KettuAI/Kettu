// Test helpers: transports and ports that connect two ends inside the test process.

import type { PortChannel } from '@shared/port-channel'
import type { Transport } from '@shared/remote/transport'

interface End<T> {
  send(message: T): void
  onMessage(listener: (message: T) => void): void
  onClose(listener: () => void): void
  close(): void
}

/** Two connected ends; each message arrives on a later task, copied as a real channel would. */
function pair<T>(copy: (message: T) => T): [End<T>, End<T>] {
  const listeners: (((message: T) => void) | null)[] = [null, null]
  const waiting: T[][] = [[], []]
  const closeListeners: (() => void)[][] = [[], []]
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    // After the messages already on their way.
    setTimeout(() => {
      for (const side of closeListeners) for (const notify of side.splice(0)) notify()
    }, 0)
  }
  const end = (self: 0 | 1): End<T> => {
    const other = self === 0 ? 1 : 0
    return {
      send: (message) => {
        if (closed) return
        const copied = copy(message)
        setTimeout(() => {
          const listener = listeners[other]
          if (listener) listener(copied)
          else waiting[other]!.push(copied)
        }, 0)
      },
      onMessage: (listener) => {
        listeners[self] = listener
        for (const message of waiting[self]!.splice(0)) listener(message)
      },
      onClose: (listener) => {
        if (closed) setTimeout(listener, 0)
        else closeListeners[self]!.push(listener)
      },
      close,
    }
  }
  return [end(0), end(1)]
}

/** A device's end and the host's end of one connection. */
export function memoryTransports(): [Transport, Transport] {
  return pair<Uint8Array>((message) => message.slice())
}

/** The two ends of a port, as a MessageChannel's. */
export function memoryPorts(): [PortChannel, PortChannel] {
  return pair<unknown>((message) => structuredClone(message))
}
