// An in-memory relay that speaks the relay protocol, for the clients' tests: its sockets follow
// the part of the standard WebSocket API the clients use, and it checks keys, signatures and
// tokens as the relay does. Not for production.

import {
  MAX_DEVICE_CONNECTIONS,
  PING,
  PONG,
  RELAY_CLOSE,
  RELAY_PROTOCOL,
  decodeRelayBytes,
  newRelayToken,
  parseDeviceToRelay,
  parseHostToRelay,
  relayHostId,
  relayOrigin,
  signInText,
  verifyRelaySignature,
  type RelayRegion,
} from './relay'

type Listener = (event: never) => void

/** How the relay at an origin behaves, for the tests that need it otherwise. */
export type FakeRelayMode =
  /** Speaks the protocol. */
  | 'up'
  /** Fails every socket before it opens, as a relay that cannot be reached. */
  | 'down'
  /** Opens every socket and then says nothing. */
  | 'silent'

/** One end of a socket, as a client holds it. */
export class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  binaryType: 'arraybuffer' | 'blob' = 'blob'
  bufferedAmount = 0
  /** The code the socket closed with, once it did. */
  closeCode: number | null = null
  /** What the client sent, in order: text as strings, binary as bytes. */
  readonly sent: (string | Uint8Array)[] = []
  private readonly listeners = new Map<string, Set<Listener>>()
  /** The relay's side of this socket. */
  onSend: ((data: string | Uint8Array) => void) | null = null
  onClosed: ((code: number) => void) | null = null

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== this.OPEN) throw new Error('The socket is not open')
    const copy =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data.slice(0))
          : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
    this.sent.push(copy)
    void Promise.resolve().then(() => this.onSend?.(copy))
  }

  close(code = 1000): void {
    if (this.readyState >= this.CLOSING) return
    this.readyState = this.CLOSING
    this.onClosed?.(code)
    this.closed(code)
  }

  /** The relay opens the socket. */
  opened(): void {
    if (this.readyState !== this.CONNECTING) return
    this.readyState = this.OPEN
    this.emit('open', {})
  }

  /** The relay sends text or bytes. */
  receive(data: string | Uint8Array): void {
    if (this.readyState !== this.OPEN) return
    const value =
      typeof data === 'string' || this.binaryType !== 'arraybuffer'
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    void Promise.resolve().then(() => {
      if (this.readyState === this.OPEN) this.emit('message', { data: value })
    })
  }

  /** The socket ends with `code`, as when the relay closes it. */
  closed(code: number): void {
    if (this.readyState === this.CLOSED) return
    const opened = this.readyState !== this.CONNECTING
    this.readyState = this.CLOSED
    this.closeCode = code
    void Promise.resolve().then(() => {
      if (!opened) this.emit('error', {})
      this.emit('close', { code, reason: '', wasClean: code !== 1006 })
    })
  }

  private emit(type: string, event: object): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      ;(listener as (event: object) => void)(event)
    }
  }
}

interface Host {
  socket: FakeSocket
  account: string
}

interface Waiting {
  device: FakeSocket
  host: string
}

/** One relay at an origin, as the tests see it. */
export class FakeRelayServer {
  mode: FakeRelayMode = 'up'
  /** Whether `ping` gets its `pong`; off, as a relay that stopped answering. */
  pongs = true
  regions: RelayRegion[] = []
  /** Hosts signed in, by id. */
  readonly hosts = new Map<string, Host>()
  /** Every socket made, in order. */
  readonly sockets: FakeSocket[] = []
  private readonly waiting = new Map<string, Waiting>()
  private readonly joined = new Map<FakeSocket, FakeSocket>()

  constructor(
    readonly origin: string,
    private readonly accounts: Map<string, string>,
  ) {}

  /** What `GET /v1` answers. */
  info(): unknown {
    if (this.mode !== 'up') throw new Error(`${this.origin} cannot be reached`)
    return { relay: 'kettu', protocol: RELAY_PROTOCOL, regions: this.regions }
  }

  /** Devices joined to a host now. */
  devices(id: string): number {
    let count = 0
    for (const waiting of this.waiting.values()) if (waiting.host === id) count++
    for (const socket of this.joined.keys())
      if (socket.url.includes(`/v1/hosts/${id}/connect`)) count++
    return count
  }

  /** Closes the host's control socket, as when the relay restarts. */
  drop(id: string, code = 1006): void {
    this.hosts.get(id)?.socket.closed(code)
  }

  open(url: string): FakeSocket {
    const socket = new FakeSocket(url)
    this.sockets.push(socket)
    void Promise.resolve().then(() => this.connect(socket))
    return socket
  }

  private connect(socket: FakeSocket): void {
    if (this.mode === 'down') return socket.closed(1006)
    const path = new URL(socket.url).pathname
    const match = /^\/v1\/hosts\/([a-z2-7]{26})(?:\/(connect)|\/accept\/([A-Za-z0-9_-]+))?$/.exec(
      path,
    )
    socket.opened()
    if (this.mode === 'silent') return
    socket.onClosed = (code) => this.ended(socket, code)
    if (!match) return this.refuse(socket, RELAY_CLOSE.malformed)
    const [, id, connect, token] = match as unknown as [string, string, string?, string?]
    if (token) return this.accept(socket, id, token)
    if (connect) return this.device(socket, id)
    this.host(socket, id)
  }

  private host(socket: FakeSocket, id: string): void {
    const nonce = newRelayToken()
    let signedIn = false
    socket.onSend = async (data) => {
      if (data === PING) return this.pongs ? socket.receive(PONG) : undefined
      const message = typeof data === 'string' ? parseHostToRelay(data) : null
      if (!message) return this.refuse(socket, RELAY_CLOSE.malformed)
      if (message.type === 'token') {
        if (!signedIn) return this.refuse(socket, RELAY_CLOSE.malformed)
        const account = this.accounts.get(message.token)
        if (!account || account !== this.hosts.get(id)?.account) {
          return this.refuse(socket, RELAY_CLOSE.unauthorized)
        }
        return
      }
      if (signedIn) return this.refuse(socket, RELAY_CLOSE.malformed)
      const publicKey = decodeRelayBytes(message.publicKey)!
      const signature = decodeRelayBytes(message.signature)!
      const text = signInText(this.origin, id, nonce)
      const account = this.accounts.get(message.token)
      if (
        (await relayHostId(publicKey)) !== id ||
        !(await verifyRelaySignature(publicKey, signature, text)) ||
        !account
      ) {
        return this.refuse(socket, RELAY_CLOSE.unauthorized)
      }
      signedIn = true
      const before = this.hosts.get(id)
      this.hosts.set(id, { socket, account })
      if (before) {
        before.socket.receive(JSON.stringify({ type: 'replaced' }))
        this.refuse(before.socket, RELAY_CLOSE.replaced)
      }
      socket.receive(JSON.stringify({ type: 'ready' }))
    }
    socket.receive(JSON.stringify({ type: 'challenge', nonce }))
  }

  private device(socket: FakeSocket, id: string): void {
    socket.onSend = (data) => {
      if (data === PING) return socket.receive(PONG)
      if (this.joined.has(socket)) {
        if (typeof data === 'string') return this.refuse(socket, RELAY_CLOSE.malformed)
        return this.joined.get(socket)!.receive(data)
      }
      const message = typeof data === 'string' ? parseDeviceToRelay(data) : null
      if (!message || [...this.waiting.values()].some((entry) => entry.device === socket)) {
        return this.refuse(socket, RELAY_CLOSE.malformed)
      }
      const host = this.hosts.get(id)
      if (!host) return this.refuse(socket, RELAY_CLOSE.offline)
      if (this.accounts.get(message.token) !== host.account) {
        return this.refuse(socket, RELAY_CLOSE.forbidden)
      }
      if (this.devices(id) >= MAX_DEVICE_CONNECTIONS) {
        return this.refuse(socket, RELAY_CLOSE.tooMany)
      }
      const token = newRelayToken()
      this.waiting.set(token, { device: socket, host: id })
      host.socket.receive(JSON.stringify({ type: 'incoming', token }))
    }
  }

  private accept(socket: FakeSocket, id: string, token: string): void {
    const waiting = this.waiting.get(token)
    this.waiting.delete(token)
    if (!waiting || waiting.host !== id || waiting.device.readyState !== waiting.device.OPEN) {
      return this.refuse(socket, RELAY_CLOSE.offline)
    }
    const { device } = waiting
    this.joined.set(device, socket)
    this.joined.set(socket, device)
    socket.onSend = (data) => {
      if (data === PING) return socket.receive(PONG)
      if (typeof data === 'string') return this.refuse(socket, RELAY_CLOSE.malformed)
      device.receive(data)
    }
    device.receive(JSON.stringify({ type: 'joined' }))
  }

  private refuse(socket: FakeSocket, code: number): void {
    this.ended(socket, code)
    socket.closed(code)
  }

  /** Either end closing closes the other; a host going leaves its waiting devices offline. */
  private ended(socket: FakeSocket, code: number): void {
    const other = this.joined.get(socket)
    if (other) {
      this.joined.delete(socket)
      this.joined.delete(other)
      other.closed(code === RELAY_CLOSE.tooBig || code >= 4000 ? code : 1000)
    }
    for (const [token, waiting] of this.waiting) {
      if (waiting.device === socket) this.waiting.delete(token)
    }
    for (const [id, host] of this.hosts) {
      if (host.socket !== socket) continue
      this.hosts.delete(id)
      for (const [token, waiting] of this.waiting) {
        if (waiting.host !== id) continue
        this.waiting.delete(token)
        waiting.device.closed(RELAY_CLOSE.offline)
      }
    }
  }
}

/** Every relay of a test, by origin, with the accounts their tokens belong to. */
export class FakeRelays {
  /** The account each access token belongs to. */
  readonly accounts = new Map<string, string>()
  private readonly servers = new Map<string, FakeRelayServer>()

  relay(url: string): FakeRelayServer {
    const origin = relayOrigin(url)
    if (!origin) throw new Error(`${url} is not a relay`)
    let server = this.servers.get(origin)
    if (!server) this.servers.set(origin, (server = new FakeRelayServer(origin, this.accounts)))
    return server
  }

  /** Opens a socket to a relay's path, as `new WebSocket(url)` does. */
  readonly openSocket = (url: string): WebSocket => {
    const parsed = new URL(url)
    const origin = `${parsed.protocol === 'wss:' ? 'https:' : 'http:'}//${parsed.host}`
    return this.relay(origin).open(url) as unknown as WebSocket
  }

  /** Reads `GET /v1` of a relay. */
  readonly fetchInfo = async (url: string): Promise<unknown> => this.relay(url).info()
}
