// A device's side of the relay: asks each of a host's relays in turn to join it to the host, the
// next one starting when the one before has not joined in a moment, and keeps the first that
// does. It asks each to say when its region drains, which it may later do on the joined socket.
// Runs on the standard WebSocket API alone, so the desktop app and the web client share it.

import {
  CONNECT_TIMEOUT_MS,
  connectMessage,
  connectSocketPath,
  isDrain,
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

/** A relay to try: its origin, and the pin of its certificate when it is at an IP address. */
export interface RelayEndpoint {
  url: string
  pin?: string
}

/** How one relay's try ended, for the day's report. */
export type RelayAttempt = 'joined' | 'unreachable' | 'answered'

export interface RelayDialOptions {
  /** The relays, in the order to try them. */
  relays: (string | RelayEndpoint)[]
  /** The host's relay id. */
  id: string
  /** This device's relay token, or its access token where the relays take no other. */
  token: string
  openSocket(url: string, pin?: string): WebSocket
  /** A relay's try ended: it joined, it could not be reached, or it answered without joining. */
  attempted?(relay: string, outcome: RelayAttempt): void
  /** The relay that joined says its region drains; the session should move. */
  drained?(relay: string): void
  /** How long the whole try has. */
  timeoutMs: number
  staggerMs?: number
  signal?: AbortSignal
}

/** Joins the host through the first relay that can, or says why none did. */
export function dialRelay(options: RelayDialOptions): Promise<RelayDialResult> {
  const { id, token, openSocket, timeoutMs, signal } = options
  const relays = options.relays.map((relay) => (typeof relay === 'string' ? { url: relay } : relay))
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

    const attempt = (endpoint: RelayEndpoint): void => {
      const relay = endpoint.url
      let socket: WebSocket
      try {
        socket = openSocket(relaySocketUrl(relay, connectSocketPath(id)), endpoint.pin)
      } catch {
        options.attempted?.(relay, 'unreachable')
        return settled()
      }
      sockets.add(socket)
      let opened = false
      const connectTimer = setTimeout(() => close(socket), CONNECT_TIMEOUT_MS + timeoutMs)
      const onMessage = (event: MessageEvent): void => {
        if (done || !isJoined(event.data)) return
        cleanup()
        options.attempted?.(relay, 'joined')
        const { drained } = options
        if (drained) {
          const onDrain = (later: MessageEvent): void => {
            if (!isDrain(later.data)) return
            socket.removeEventListener('message', onDrain)
            drained(relay)
          }
          socket.addEventListener('message', onDrain)
        }
        finish({ kind: 'joined', socket, relay })
      }
      const onOpen = (): void => {
        opened = true
        socket.send(JSON.stringify(connectMessage(token)))
      }
      const onClose = (event: CloseEvent): void => {
        cleanup()
        sockets.delete(socket)
        if (opened) {
          const reason = relayRefusal(event.code)
          // A relay that closed without a reason answered, but said nothing of the host.
          refusals.push(reason ?? 'offline')
        }
        if (!done) options.attempted?.(relay, opened ? 'answered' : 'unreachable')
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
