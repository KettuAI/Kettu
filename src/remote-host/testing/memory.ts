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

/** A transport over one end, which keeps what arrives while it is paused. */
function unbuffered(end: End<Uint8Array>): Transport {
  let paused = false
  let listener: ((message: Uint8Array) => void) | null = null
  const waiting: Uint8Array[] = []
  const deliver = (): void => {
    while (!paused && listener && waiting.length > 0) listener(waiting.shift()!)
  }
  end.onMessage((message) => {
    waiting.push(message)
    deliver()
  })
  return {
    ...end,
    onMessage: (next) => {
      listener = next
      deliver()
    },
    buffered: () => 0,
    drained: () => Promise.resolve(),
    pause: () => (paused = true),
    resume: () => {
      paused = false
      deliver()
    },
  }
}

/** A device's end and the host's end of one connection. */
export function memoryTransports(): [Transport, Transport] {
  const [device, host] = pair<Uint8Array>((message) => message.slice())
  return [unbuffered(device), unbuffered(host)]
}

/** The host's end of a connection whose device can stop reading, which the host then buffers. */
export interface HeldTransports {
  device: Transport
  host: Transport
  /** The device stops reading: what the host sends waits, counted as buffered. */
  hold(): void
  /** The device reads again, everything that waited first. */
  release(): void
  /** Bytes the host has sent in all, read or not. */
  sent(): number
  /** The length of each transport message waiting, in order. */
  waiting(): number[]
}

export function heldTransports(): HeldTransports {
  const [device, host] = memoryTransports()
  let holding = false
  let held: Uint8Array[] = []
  let heldBytes = 0
  let sent = 0
  const drains: (() => void)[] = []
  return {
    device,
    host: {
      ...host,
      send: (message) => {
        sent += message.length
        if (!holding) return host.send(message)
        held.push(message)
        heldBytes += message.length
      },
      buffered: () => heldBytes,
      drained: () =>
        heldBytes === 0 ? Promise.resolve() : new Promise((resolve) => drains.push(resolve)),
    },
    hold: () => (holding = true),
    release: () => {
      holding = false
      for (const message of held) host.send(message)
      held = []
      heldBytes = 0
      for (const resolve of drains.splice(0)) resolve()
    },
    sent: () => sent,
    waiting: () => held.map((message) => message.length),
  }
}

/** The two ends of a port, as a MessageChannel's. */
export function memoryPorts(): [PortChannel, PortChannel] {
  return pair<unknown>((message) => structuredClone(message))
}
