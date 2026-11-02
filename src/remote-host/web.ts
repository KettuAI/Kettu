// What the direct port answers browsers: the web client's files over HTTP, and its channel as a
// WebSocket at /channel, each binary message one Noise message. The direct listener hands over
// each connection that starts with an HTTP request; nothing here listens on its own.

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { WebSocketServer, type WebSocket } from 'ws'
import { ARTIFACT_CSP, ARTIFACT_PERMISSIONS_POLICY } from '@shared/artifact-policy'
import { MAX_NOISE_MESSAGE } from '@shared/remote/noise'
import type { Transport } from '@shared/remote/transport'
import type { LogFn } from '../agent-host/storage'
import { CLOSE_GRACE_MS, type HandshakeLimits } from './limits'
import type { RemoteServer } from './server'

/** How long an HTTP connection has for a request's headers, at first and after each response. */
const REQUEST_TIMEOUT_MS = 10_000

/** HTTP connections at once: a few for each browser loading the client. More are cut. */
const MAX_HTTP_CONNECTIONS = 64

/** How often a WebSocket is pinged; one that did not answer the ping before is cut. */
const PING_MS = 30_000

const CHANNEL_PATH = '/channel'

/** The web client's service worker, which its build names with a hash, as every asset. */
const MEDIA_WORKER_PREFIX = '/assets/media-worker-'

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const PAGE_HEADERS = {
  'Content-Security-Policy': PAGE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
}

// The sandbox gives an artifact's frame an opaque origin, but 'self' would still name the web
// client's, so the artifact's own policy goes without it.
const FRAME_CSP = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals',
  "frame-ancestors 'self'",
  ...ARTIFACT_CSP.split('; ').map((directive) => {
    const [name, ...sources] = directive.split(' ')
    const kept = sources.filter((source) => source !== "'self'")
    return [name, ...(kept.length > 0 ? kept : ["'none'"])].join(' ')
  }),
].join('; ')

const FRAME_HEADERS = {
  'Content-Security-Policy': FRAME_CSP,
  'Permissions-Policy': ARTIFACT_PERMISSIONS_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}

const IMMUTABLE = 'public, max-age=31536000, immutable'

interface WebFile {
  file: string
  type: string
}

export interface WebServerOptions {
  /** The folder of the web client's built files, or null in a build without one. */
  root: string | null
  server: Pick<RemoteServer, 'accept' | 'refusedOne'>
  /** The direct port's, which a WebSocket's handshake spends like a TCP connection's. */
  limits: HandshakeLimits
  log: LogFn
  requestTimeoutMs?: number
}

/** The web client's files and channel on the direct port. */
export class WebServer {
  private readonly http: Server
  private readonly sockets: WebSocketServer
  /** HTTP connections, each with the timer that cuts it while it waits for a request. */
  private readonly connections = new Map<Socket, ReturnType<typeof setTimeout> | null>()
  private files: Promise<Map<string, WebFile> | null> | null = null

  constructor(private readonly options: WebServerOptions) {
    // Any other upgrade, such as curl's h2c, gets an HTTP/1.1 answer, where Node.js has the option.
    this.http = createServer({
      shouldUpgradeCallback: (request) => request.headers.upgrade?.toLowerCase() === 'websocket',
    })
    this.http.on('request', (request: IncomingMessage, response: ServerResponse) =>
      this.respond(request, response),
    )
    this.http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) =>
      this.upgrade(request, socket as Socket, head),
    )
    this.sockets = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_NOISE_MESSAGE,
      perMessageDeflate: false,
      clientTracking: false,
    })
  }

  /** Answers a connection whose first bytes, still unread, are an HTTP request. */
  take(socket: Socket): void {
    if (this.connections.size >= MAX_HTTP_CONNECTIONS) return void socket.destroy()
    this.connections.set(socket, null)
    socket.once('close', () => this.forget(socket))
    this.wait(socket)
    this.http.emit('connection', socket)
  }

  /** Ends every HTTP connection; the channels opened from one go on, as TCP ones do. */
  endAll(): void {
    for (const socket of this.connections.keys()) socket.destroy()
  }

  private wait(socket: Socket): void {
    if (!this.connections.has(socket)) return
    clearTimeout(this.connections.get(socket) ?? undefined)
    const timeout = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.connections.set(
      socket,
      setTimeout(() => socket.destroy(), timeout),
    )
  }

  private stopWaiting(socket: Socket): void {
    if (!this.connections.has(socket)) return
    clearTimeout(this.connections.get(socket) ?? undefined)
    this.connections.set(socket, null)
  }

  private forget(socket: Socket): void {
    clearTimeout(this.connections.get(socket) ?? undefined)
    this.connections.delete(socket)
  }

  private respond(request: IncomingMessage, response: ServerResponse): void {
    const socket = request.socket as Socket
    this.stopWaiting(socket)
    response.once('finish', () => this.wait(socket))
    this.answer(request, response).catch((error: unknown) => {
      this.options.log('warn', `The web client could not be served: ${(error as Error).message}`)
      if (response.headersSent) response.destroy()
      else plain(response, 500, 'Kettu could not read this file.')
    })
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(response, 405, 'Only GET and HEAD are allowed.', { Allow: 'GET, HEAD' })
    }
    const files = await this.load()
    const index = files?.get('/index.html')
    if (!files || !index) return plain(response, 503, 'This Kettu has no web client.')
    const pathname = pathOf(request.url)
    if (pathname === null) return plain(response, 400, 'The path is not valid.')
    const file = files.get(pathname)
    if (pathname.startsWith('/assets/')) {
      if (!file) return plain(response, 404, 'Not found.')
      // It answers the page's media URLs, so it takes the whole site from its folder.
      const worker: Record<string, string> = pathname.startsWith(MEDIA_WORKER_PREFIX)
        ? { 'Service-Worker-Allowed': '/' }
        : {}
      return send(request, response, file, {
        ...PAGE_HEADERS,
        ...worker,
        'Cache-Control': IMMUTABLE,
      })
    }
    const frame = files.get('/frame.html')
    if (frame && (pathname === '/frame.html' || pathname.startsWith('/frame/'))) {
      return send(request, response, frame, FRAME_HEADERS)
    }
    // The client's own routes, such as /pair, are its page too.
    return send(request, response, file ?? index, { ...PAGE_HEADERS, 'Cache-Control': 'no-cache' })
  }

  /** The root's files, read once; requests never reach the file system by their path. */
  private load(): Promise<Map<string, WebFile> | null> {
    const { root, log } = this.options
    this.files ??= root
      ? readRoot(root).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') log('warn', `Cannot read the web client: ${error.message}`)
          return null
        })
      : Promise.resolve(null)
    return this.files
  }

  private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    // A channel now, which the direct listener ends as it ends TCP ones.
    this.forget(socket)
    const address = socket.remoteAddress
    const wanted =
      request.method === 'GET' &&
      request.headers.upgrade?.toLowerCase() === 'websocket' &&
      pathOf(request.url) === CHANNEL_PATH &&
      sameOrigin(request)
    const settle = wanted && address ? this.options.limits.admit(address) : null
    if (!settle) {
      socket.destroy()
      if (address) this.options.server.refusedOne()
      return
    }
    // A request ws turns down never reaches the callback; its socket closes.
    socket.once('close', settle)
    this.sockets.handleUpgrade(request, socket, head, (ws) => {
      this.options.server.accept(webSocketTransport(ws, settle))
    })
  }
}

/**
 * Whether a page of this host opened the WebSocket. Only browsers send an Origin, and only they
 * can be led by another site's page to connect, so a request without one may.
 */
function sameOrigin(request: IncomingMessage): boolean {
  const { origin, host } = request.headers
  if (origin === undefined) return true
  const page = URL.parse(origin)
  if (!page || !host || (page.protocol !== 'http:' && page.protocol !== 'https:')) return false
  // Read with the page's scheme, so a default port drops from both alike.
  return URL.parse(`${page.protocol}//${host}`)?.host === page.host
}

/** The request's path with its dot segments resolved and its escapes decoded, or null. */
function pathOf(url: string | undefined): string | null {
  const parsed = URL.parse(url ?? '', 'http://host')
  if (!parsed) return null
  try {
    return decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
}

/** The files under `root` by their URL path, without symbolic links. */
async function readRoot(root: string): Promise<Map<string, WebFile>> {
  const files = new Map<string, WebFile>()
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    const type = TYPES[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream'
    files.set(`/${path.relative(root, file).split(path.sep).join('/')}`, { file, type })
  }
  return files
}

async function send(
  request: IncomingMessage,
  response: ServerResponse,
  { file, type }: WebFile,
  headers: Record<string, string>,
): Promise<void> {
  const { size } = await stat(file)
  response.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': size })
  if (request.method === 'HEAD') return void response.end()
  // A browser that stops reading ends it early, which is nothing to log.
  await pipeline(createReadStream(file), response).catch(() => response.destroy())
}

function plain(
  response: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  const body = `${text}\n`
  response.writeHead(status, {
    ...PAGE_HEADERS,
    ...headers,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

/**
 * A WebSocket channel's transport, one binary message per Noise message; the handshake settles at
 * the host's first message or the end.
 */
export function webSocketTransport(ws: WebSocket, settle: () => void): Transport {
  let open = true
  let closed = false
  let paused = false
  let listener: ((message: Uint8Array) => void) | null = null
  const waiting: Uint8Array[] = []
  const closeListeners: (() => void)[] = []
  let unsent = 0
  const drains: (() => void)[] = []
  let alive = true

  const deliver = (): void => {
    while (open && !paused && listener && waiting.length > 0) listener(waiting.shift()!)
  }
  const drained = (): void => {
    for (const resolve of drains.splice(0)) resolve()
  }
  const end = (code: number): void => {
    if (!open) return
    open = false
    ws.close(code)
    setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref()
  }

  const pinging = setInterval(() => {
    if (!alive) return ws.terminate()
    alive = false
    ws.ping()
  }, PING_MS)
  ws.on('pong', () => (alive = true))
  // A protocol error, such as a message over maxPayload; 'close' follows it.
  ws.on('error', () => {})
  ws.on('message', (data, isBinary) => {
    if (!open) return
    // 1003: the channel carries binary messages only.
    if (!isBinary) return end(1003)
    // A copy, so a message keeps no larger buffer alive.
    waiting.push(new Uint8Array(data as Buffer))
    deliver()
  })
  ws.on('close', () => {
    open = false
    closed = true
    clearInterval(pinging)
    settle()
    drained()
    for (const notify of closeListeners.splice(0)) notify()
  })

  return {
    send: (message) => {
      if (message.length > MAX_NOISE_MESSAGE) throw new RangeError('Noise message is too long')
      settle()
      if (!open || ws.readyState !== ws.OPEN) return
      unsent++
      ws.send(message, { binary: true }, () => {
        if (--unsent === 0) drained()
      })
    },
    onMessage: (next) => {
      listener = next
      deliver()
    },
    onClose: (next) => {
      if (closed) queueMicrotask(next)
      else closeListeners.push(next)
    },
    close: () => {
      settle()
      end(1000)
    },
    pause: () => {
      paused = true
      ws.pause()
    },
    resume: () => {
      if (!paused) return
      paused = false
      deliver()
      // A message handed over may have paused it again.
      if (!paused) ws.resume()
    },
    buffered: () => ws.bufferedAmount,
    drained: () =>
      closed || unsent === 0 ? Promise.resolve() : new Promise((resolve) => drains.push(resolve)),
  }
}
