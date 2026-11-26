// How agents reach a remote Streamable HTTP server through the router: each request forwarded as it
// is, with the server's keys and, for one that signs in, a fresh token of the user's sign-in in
// place of anything the agent sent, and the answer streamed back, JSON or SSE alike.

import { createHash } from 'node:crypto'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { MarketServer } from '@shared/marketplace'

export const PROXY_PREFIX = '/proxy/'
/** The most a request to forward may carry, as the service's own requests. */
const BODY_BYTES = 16 * 1024 * 1024
/** How long the server has to start answering; an answer's stream then runs as long as it lasts. */
const ANSWER_MS = 60_000

const REQUEST_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
  // The stateless protocol routes by these without reading the body.
  'mcp-method',
  'mcp-name',
]
/** Headers a tool's arguments are mirrored into in the stateless protocol, passed on unread. */
const PARAM_HEADER = /^mcp-param-[a-z0-9-]+$/
const ANSWER_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control']

/** The proxy's path for a server: a digest of its id, which leaks nothing and needs no escaping. */
export function proxyPath(serverId: string): string {
  return `${PROXY_PREFIX}${createHash('sha256').update(serverId).digest('hex').slice(0, 24)}`
}

export interface ProxyDeps {
  /** Whether requests to it carry the user's sign-in, rather than none for an open server. */
  signsIn(server: MarketServer): boolean
  /** The server's fixed headers and filled inputs. */
  headers(server: MarketServer): Record<string, string>
  /** A fresh token, or null when the server is not connected. */
  token(serverId: string): Promise<string | null>
  /** The server refused `used`: a renewed token, or null when it cannot be renewed. */
  refused(serverId: string, used: string): Promise<string | null>
  fetch?: typeof fetch
}

function refuse(
  res: http.ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

async function body(req: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > BODY_BYTES) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export class McpProxy {
  private readonly fetch: typeof fetch

  constructor(private readonly deps: ProxyDeps) {
    this.fetch = deps.fetch ?? fetch
  }

  /** A request for `server`, whose caller the router has already let through to it. */
  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    server: MarketServer,
  ): Promise<void> {
    if (server.spec.type !== 'http') return refuse(res, 404, 'Not found')
    const oauth = this.deps.signsIn(server)
    const method = req.method ?? 'GET'
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      return refuse(res, 405, 'Method not allowed', { Allow: 'GET, POST, DELETE' })
    }
    const payload = method === 'POST' ? await body(req) : null
    if (method === 'POST' && payload === null) return refuse(res, 413, 'The request is too large')
    let token = oauth ? await this.deps.token(server.id) : ''
    if (token === null) return this.signIn(res)
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const headers: Record<string, string> = { ...this.deps.headers(server) }
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value !== 'string') continue
      if (REQUEST_HEADERS.includes(name) || PARAM_HEADER.test(name)) headers[name] = value
    }
    const send = (bearer: string): Promise<Response> => {
      const timer = setTimeout(() => abort.abort(), ANSWER_MS)
      return this.fetch(server.spec.type === 'http' ? server.spec.url : '', {
        method,
        headers: oauth ? { ...headers, Authorization: `Bearer ${bearer}` } : headers,
        ...(payload ? { body: payload } : {}),
        signal: abort.signal,
      }).finally(() => clearTimeout(timer))
    }
    let answer: Response
    try {
      answer = await send(token)
      if (answer.status === 401 && oauth) {
        void answer.body?.cancel()
        token = await this.deps.refused(server.id, token)
        if (token === null) return this.signIn(res)
        answer = await send(token)
        if (answer.status === 401) {
          void answer.body?.cancel()
          await this.deps.refused(server.id, token)
          return this.signIn(res)
        }
      }
    } catch (error) {
      if (abort.signal.aborted && res.destroyed) return
      return refuse(res, 502, `The server could not be reached: ${(error as Error).message}`)
    }
    const out: Record<string, string> = {}
    for (const name of ANSWER_HEADERS) {
      const value = answer.headers.get(name)
      if (value !== null) out[name] = value
    }
    res.writeHead(answer.status, out)
    if (!answer.body) {
      res.end()
      return
    }
    const stream = Readable.fromWeb(answer.body as WebReadableStream<Uint8Array>)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  private signIn(res: http.ServerResponse): void {
    refuse(res, 401, 'The server needs connecting again in Kettu')
  }
}
