// A device's side of the relay: asks each of a host's relays in turn to join it to the host, the
// next one starting when the one before has not joined in a moment, and keeps the first that
// does. Runs on the standard WebSocket API alone, so the desktop app and the web client share it.

import {
  CONNECT_TIMEOUT_MS,
  connectSocketPath,
  isJoined,
  relayRefusal,
  relaySocketUrl,
  type RelayRefusal,
} from './relay'

/** How long a relay has to join before the next one is asked too. */
export const RELAY_STAGGER_MS = 2000

export type RelayDialResult =
  | { kind: 'joined'; socket: WebSocket; relay: string }
  /** Every relay that answered said the host is not signed in to it. */
  | { kind: 'offline' }
  /** A relay refused this device's account: it is not the host's, or the sign-in is not valid. */
  | { kind: 'forbidden' }
  /** A relay refused for another reason, such as too many connections. */
  | { kind: 'refused'; reason: RelayRefusal }
  /** No relay answered. */
  | { kind: 'unreachable' }
  | { kind: 'aborted' }

export interface RelayDialOptions {
  /** The relays' origins, in the order to try them. */
  relays: string[]
  /** The host's relay id. */
  id: string
  /** This device's Kettu access token. */
  token: string
  openSocket(url: string): WebSocket
  /** How long the whole try has. */
  timeoutMs: number
  staggerMs?: number
  signal?: AbortSignal
}

/** Joins the host through the first relay that can, or says why none did. */
export function dialRelay(options: RelayDialOptions): Promise<RelayDialResult> {
  const { relays, id, token, openSocket, timeoutMs, signal } = options
  const stagger = options.staggerMs ?? RELAY_STAGGER_MS
  return new Promise((resolve) => {
    const sockets = new Set<WebSocket>()
    const refusals: RelayRefusal[] = []
    let next = 0
    let unsettled = relays.length
    let done = false
    let staggerTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: RelayDialResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (staggerTimer) clearTimeout(staggerTimer)
      signal?.removeEventListener('abort', abort)
      for (const socket of sockets) {
        if (result.kind !== 'joined' || socket !== result.socket) close(socket)
      }
      sockets.clear()
      resolve(result)
    }
    const verdict = (): RelayDialResult => {
      if (refusals.includes('forbidden')) return { kind: 'forbidden' }
      if (refusals.length === 0) return { kind: 'unreachable' }
      if (refusals.every((reason) => reason === 'offline')) return { kind: 'offline' }
      return { kind: 'refused', reason: refusals.find((reason) => reason !== 'offline')! }
    }
    const settled = (): void => {
      unsettled--
      if (done) return
      if (unsettled === 0) return finish(verdict())
      // One that failed makes way for the next at once.
      startNext()
    }
    const abort = (): void => finish({ kind: 'aborted' })
    const timer = setTimeout(() => finish(verdict()), timeoutMs)

    const attempt = (relay: string): void => {
      let socket: WebSocket
      try {
        socket = openSocket(relaySocketUrl(relay, connectSocketPath(id)))
      } catch {
        return settled()
      }
      sockets.add(socket)
      let opened = false
      const connectTimer = setTimeout(() => close(socket), CONNECT_TIMEOUT_MS + timeoutMs)
      const onMessage = (event: MessageEvent): void => {
        if (done || !isJoined(event.data)) return
        cleanup()
        finish({ kind: 'joined', socket, relay })
      }
      const onOpen = (): void => {
        opened = true
        socket.send(JSON.stringify({ type: 'connect', token }))
      }
      const onClose = (event: CloseEvent): void => {
        cleanup()
        sockets.delete(socket)
        if (opened) {
          const reason = relayRefusal(event.code)
          // A relay that closed without a reason answered, but said nothing of the host.
          refusals.push(reason ?? 'offline')
        }
        settled()
      }
      const cleanup = (): void => {
        clearTimeout(connectTimer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('close', onClose)
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('message', onMessage)
      socket.addEventListener('close', onClose)
    }
    const startNext = (): void => {
      if (staggerTimer) clearTimeout(staggerTimer)
      staggerTimer = null
      if (done || next >= relays.length) return
      attempt(relays[next++]!)
      if (next < relays.length) staggerTimer = setTimeout(startNext, stagger)
    }

    if (signal?.aborted) return finish({ kind: 'aborted' })
    signal?.addEventListener('abort', abort, { once: true })
    if (relays.length === 0) return finish({ kind: 'unreachable' })
    startNext()
  })
}

function close(socket: WebSocket): void {
  try {
    socket.close(1000)
  } catch {
    // Already closing.
  }
}
