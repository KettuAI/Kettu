// Lightweight, protocol-safe HTTP/1.x header rewriting for forwarded dev server connections when
// a local fallback port differs from the remote host's port. Keeps Host, Origin, Referer,
// Access-Control-Allow-Origin, and Location consistent across HTTP/1.1 keep-alive and WebSocket /
// HMR handshakes, while passing TLS, upgraded frames, and non-HTTP TCP streams through untouched.

const HEADER_END = Buffer.from('\r\n\r\n', 'latin1')
const CRLF = Buffer.from('\r\n', 'latin1')
const MAX_HEADER_BYTES = 64 * 1024
const MAX_CHUNK_LINE_BYTES = 4 * 1024

const HTTP_METHODS = [
  'GET ',
  'POST ',
  'PUT ',
  'DELETE ',
  'PATCH ',
  'HEAD ',
  'OPTIONS ',
  'CONNECT ',
  'TRACE ',
] as const

const MAX_METHOD_PREFIX = 8
const RESPONSE_PREFIX = 'HTTP/1.'

export interface ForwardPortMapping {
  localPort: number
  remotePort: number
}

function isLoopbackName(host: string): boolean {
  const lower = host.toLowerCase()
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '[::1]' ||
    lower.endsWith('.localhost')
  )
}

function defaultPort(scheme: string): number {
  return scheme.toLowerCase() === 'https' ? 443 : 80
}

function formatOrigin(scheme: string, host: string, port: number): string {
  return port === defaultPort(scheme) ? `${scheme}://${host}` : `${scheme}://${host}:${port}`
}

function formatHost(host: string, port: number): string {
  return port === 80 ? host : `${host}:${port}`
}

const HOST_HEADER_RE = /^((?:\[::1\]|[a-z0-9.-]+)):(\d+)$/i
const ORIGIN_RE = /^(https?):\/\/((?:\[::1\]|[a-z0-9.-]+))(?::(\d+))?$/i
const URL_ORIGIN_RE = /^(https?):\/\/((?:\[::1\]|[a-z0-9.-]+))(?::(\d+))?(?=$|[/?#])/i

function rewriteHostValue(value: string, localPort: number, remotePort: number): string {
  if (localPort === remotePort) return value
  const match = HOST_HEADER_RE.exec(value.trim())
  if (!match) return value
  const [, host, portText] = match
  if (!host || !isLoopbackName(host) || Number(portText) !== localPort) return value
  return formatHost(host, remotePort)
}

function rewriteLocalOriginToRemote(
  value: string,
  mappings: readonly ForwardPortMapping[],
  prefixOnly: boolean,
): string {
  const trimmed = value.trim()
  const match = (prefixOnly ? URL_ORIGIN_RE : ORIGIN_RE).exec(trimmed)
  if (!match) return value
  const [matched, scheme, host, portText] = match
  if (!scheme || !host || !isLoopbackName(host)) return value
  const port = portText ? Number(portText) : defaultPort(scheme)
  const mapping = mappings.find(
    (entry) => entry.localPort === port && entry.localPort !== entry.remotePort,
  )
  if (!mapping) return value
  const rewrittenOrigin = formatOrigin(scheme, host, mapping.remotePort)
  return prefixOnly ? rewrittenOrigin + trimmed.slice(matched.length) : rewrittenOrigin
}

function rewriteRemoteOriginToLocal(
  value: string,
  mappings: readonly ForwardPortMapping[],
  prefixOnly: boolean,
): string {
  const trimmed = value.trim()
  const match = (prefixOnly ? URL_ORIGIN_RE : ORIGIN_RE).exec(trimmed)
  if (!match) return value
  const [matched, scheme, host, portText] = match
  if (!scheme || !host || !isLoopbackName(host)) return value
  const port = portText ? Number(portText) : defaultPort(scheme)
  const mapping = mappings.find(
    (entry) => entry.remotePort === port && entry.localPort !== entry.remotePort,
  )
  if (!mapping) return value
  const rewrittenOrigin = formatOrigin(scheme, host, mapping.localPort)
  return prefixOnly ? rewrittenOrigin + trimmed.slice(matched.length) : rewrittenOrigin
}

export interface RewrittenRequestHead {
  head: Buffer
  method: string
  upgrade: boolean
  chunked: boolean
  contentLength: number | null
  hasUnknownTransferEncoding: boolean
}

export function rewriteRequestHeaders(
  rawHead: Buffer,
  localPort: number,
  remotePort: number,
  mappings: readonly ForwardPortMapping[],
): RewrittenRequestHead {
  const text = rawHead.toString('latin1')
  const lines = text.split('\r\n')
  const requestLine = lines[0] ?? ''
  const method = requestLine.split(' ', 1)[0] ?? ''

  let upgrade = method === 'CONNECT'
  let chunked = false
  let hasTransferEncoding = false
  let contentLength: number | null = null

  const outLines: string[] = [requestLine]
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    const colon = line.indexOf(':')
    if (colon <= 0) {
      outLines.push(line)
      continue
    }
    const name = line.slice(0, colon)
    const lower = name.toLowerCase()
    const rawValue = line.slice(colon + 1)
    const trimmed = rawValue.trim()

    if (lower === 'upgrade' && trimmed.length > 0) upgrade = true
    else if (
      lower === 'connection' &&
      trimmed
        .toLowerCase()
        .split(',')
        .some((t) => t.trim() === 'upgrade')
    ) {
      upgrade = true
    } else if (lower === 'transfer-encoding') {
      hasTransferEncoding = true
      if (
        trimmed
          .toLowerCase()
          .split(',')
          .some((t) => t.trim() === 'chunked')
      )
        chunked = true
    } else if (lower === 'content-length') {
      const parsed = Number(trimmed)
      if (/^\d+$/.test(trimmed) && Number.isSafeInteger(parsed)) contentLength = parsed
    }

    let updated = trimmed
    if (lower === 'host') {
      updated = rewriteHostValue(trimmed, localPort, remotePort)
    } else if (lower === 'origin') {
      updated = rewriteLocalOriginToRemote(trimmed, mappings, false)
    } else if (lower === 'referer') {
      updated = rewriteLocalOriginToRemote(trimmed, mappings, true)
    }

    outLines.push(updated === trimmed ? line : `${name}: ${updated}`)
  }

  return {
    head: Buffer.from(`${outLines.join('\r\n')}\r\n\r\n`, 'latin1'),
    method,
    upgrade,
    chunked,
    contentLength,
    hasUnknownTransferEncoding: hasTransferEncoding && !chunked,
  }
}

export interface RewrittenResponseHead {
  head: Buffer
  status: number
  chunked: boolean
  contentLength: number | null
  hasUnknownTransferEncoding: boolean
}

export function rewriteResponseHeaders(
  rawHead: Buffer,
  mappings: readonly ForwardPortMapping[],
): RewrittenResponseHead {
  const text = rawHead.toString('latin1')
  const lines = text.split('\r\n')
  const statusLine = lines[0] ?? ''
  const statusMatch = /^HTTP\/1\.\d\s+(\d{3})/.exec(statusLine)
  const status = statusMatch ? Number(statusMatch[1]) : 0

  let chunked = false
  let hasTransferEncoding = false
  let contentLength: number | null = null

  const outLines: string[] = [statusLine]
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    const colon = line.indexOf(':')
    if (colon <= 0) {
      outLines.push(line)
      continue
    }
    const name = line.slice(0, colon)
    const lower = name.toLowerCase()
    const trimmed = line.slice(colon + 1).trim()

    if (lower === 'transfer-encoding') {
      hasTransferEncoding = true
      if (
        trimmed
          .toLowerCase()
          .split(',')
          .some((t) => t.trim() === 'chunked')
      )
        chunked = true
    } else if (lower === 'content-length') {
      const parsed = Number(trimmed)
      if (/^\d+$/.test(trimmed) && Number.isSafeInteger(parsed)) contentLength = parsed
    }

    let updated = trimmed
    if (lower === 'access-control-allow-origin') {
      updated = rewriteRemoteOriginToLocal(trimmed, mappings, false)
    } else if (lower === 'location') {
      updated = rewriteRemoteOriginToLocal(trimmed, mappings, true)
    }

    outLines.push(updated === trimmed ? line : `${name}: ${updated}`)
  }

  return {
    head: Buffer.from(`${outLines.join('\r\n')}\r\n\r\n`, 'latin1'),
    status,
    chunked,
    contentLength,
    hasUnknownTransferEncoding: hasTransferEncoding && !chunked,
  }
}

function couldBeHttpRequest(buf: Buffer): 'yes' | 'no' | 'need_more' {
  const sample = buf.subarray(0, Math.min(buf.length, MAX_METHOD_PREFIX)).toString('latin1')
  let partial = false
  for (const prefix of HTTP_METHODS) {
    if (sample.startsWith(prefix)) return 'yes'
    if (prefix.startsWith(sample)) partial = true
  }
  return partial ? 'need_more' : 'no'
}

function couldBeHttpResponse(buf: Buffer): 'yes' | 'no' | 'need_more' {
  const sample = buf.subarray(0, Math.min(buf.length, RESPONSE_PREFIX.length)).toString('latin1')
  if (sample.startsWith(RESPONSE_PREFIX)) return 'yes'
  if (RESPONSE_PREFIX.startsWith(sample)) return 'need_more'
  return 'no'
}

type StreamMode =
  | { kind: 'detect' }
  | { kind: 'headers' }
  | { kind: 'fixed'; remaining: number }
  | { kind: 'chunk_size' }
  | { kind: 'chunk_data'; remaining: number }
  | { kind: 'chunk_trailers' }
  | { kind: 'passthrough' }

class DirectionalRewriter {
  private mode: StreamMode = { kind: 'detect' }
  private buffer: Buffer = Buffer.alloc(0)

  constructor(
    private readonly detect: (buf: Buffer) => 'yes' | 'no' | 'need_more',
    private readonly onHead: (rawHead: Buffer) => { head: Buffer; next: StreamMode },
  ) {}

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return []
    const input = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    if (this.mode.kind === 'passthrough') return [input]

    this.buffer = this.buffer.length === 0 ? input : Buffer.concat([this.buffer, input])
    const out: Uint8Array[] = []

    while (this.buffer.length > 0) {
      if (this.mode.kind === 'passthrough') {
        out.push(this.buffer)
        this.buffer = Buffer.alloc(0)
        break
      }

      if (this.mode.kind === 'detect') {
        const verdict = this.detect(this.buffer)
        if (verdict === 'need_more') break
        if (verdict === 'no') {
          this.mode = { kind: 'passthrough' }
          continue
        }
        this.mode = { kind: 'headers' }
        continue
      }

      if (this.mode.kind === 'headers') {
        const end = this.buffer.indexOf(HEADER_END)
        if (end === -1) {
          if (this.buffer.length > MAX_HEADER_BYTES) {
            this.mode = { kind: 'passthrough' }
            continue
          }
          break
        }
        const rawHead = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(end + HEADER_END.length)
        const { head, next } = this.onHead(rawHead)
        out.push(head)
        this.mode = next
        continue
      }

      if (this.mode.kind === 'fixed') {
        const take = Math.min(this.mode.remaining, this.buffer.length)
        out.push(this.buffer.subarray(0, take))
        this.buffer = this.buffer.subarray(take)
        this.mode.remaining -= take
        if (this.mode.remaining === 0) this.mode = { kind: 'detect' }
        continue
      }

      if (this.mode.kind === 'chunk_size') {
        const lineEnd = this.buffer.indexOf(CRLF)
        if (lineEnd === -1) {
          if (this.buffer.length > MAX_CHUNK_LINE_BYTES) {
            this.mode = { kind: 'passthrough' }
            continue
          }
          break
        }
        const lineText = this.buffer.subarray(0, lineEnd).toString('latin1')
        const hex = lineText.split(';', 1)[0]!.trim()
        if (!/^[0-9a-f]+$/i.test(hex)) {
          this.mode = { kind: 'passthrough' }
          continue
        }
        const size = Number.parseInt(hex, 16)
        if (!Number.isSafeInteger(size) || size < 0) {
          this.mode = { kind: 'passthrough' }
          continue
        }
        const headerBytes = this.buffer.subarray(0, lineEnd + CRLF.length)
        this.buffer = this.buffer.subarray(lineEnd + CRLF.length)
        out.push(headerBytes)
        if (size === 0) {
          this.mode = { kind: 'chunk_trailers' }
        } else {
          // Include the trailing CRLF after the chunk payload.
          this.mode = { kind: 'chunk_data', remaining: size + CRLF.length }
        }
        continue
      }

      if (this.mode.kind === 'chunk_data') {
        const take = Math.min(this.mode.remaining, this.buffer.length)
        out.push(this.buffer.subarray(0, take))
        this.buffer = this.buffer.subarray(take)
        this.mode.remaining -= take
        if (this.mode.remaining === 0) this.mode = { kind: 'chunk_size' }
        continue
      }

      if (this.mode.kind === 'chunk_trailers') {
        const lineEnd = this.buffer.indexOf(CRLF)
        if (lineEnd === -1) {
          if (this.buffer.length > MAX_HEADER_BYTES) {
            this.mode = { kind: 'passthrough' }
            continue
          }
          break
        }
        const lineBytes = this.buffer.subarray(0, lineEnd + CRLF.length)
        this.buffer = this.buffer.subarray(lineEnd + CRLF.length)
        out.push(lineBytes)
        if (lineEnd === 0) this.mode = { kind: 'detect' }
        continue
      }
    }

    return out
  }

  flush(): Uint8Array[] {
    if (this.buffer.length === 0) return []
    const remaining = this.buffer
    this.buffer = Buffer.alloc(0)
    this.mode = { kind: 'passthrough' }
    return [remaining]
  }
}

/**
 * Bidirectional HTTP/1.x header rewriter for a single forwarded TCP connection.
 * Tracks HEAD requests so their bodyless responses do not desynchronize keep-alive framing.
 */
export class HttpForwardRewriter {
  private readonly headRequests: boolean[] = []
  private readonly requests: DirectionalRewriter
  private readonly responses: DirectionalRewriter

  constructor(
    localPort: number,
    remotePort: number,
    mappings: () => readonly ForwardPortMapping[],
  ) {
    this.requests = new DirectionalRewriter(couldBeHttpRequest, (rawHead) => {
      const parsed = rewriteRequestHeaders(rawHead, localPort, remotePort, mappings())
      this.headRequests.push(parsed.method === 'HEAD')
      if (parsed.upgrade || parsed.hasUnknownTransferEncoding) {
        return { head: parsed.head, next: { kind: 'passthrough' } }
      }
      if (parsed.chunked) return { head: parsed.head, next: { kind: 'chunk_size' } }
      if (parsed.contentLength !== null && parsed.contentLength > 0) {
        return { head: parsed.head, next: { kind: 'fixed', remaining: parsed.contentLength } }
      }
      return { head: parsed.head, next: { kind: 'detect' } }
    })

    this.responses = new DirectionalRewriter(couldBeHttpResponse, (rawHead) => {
      const parsed = rewriteResponseHeaders(rawHead, mappings())
      if (parsed.status === 101) {
        this.headRequests.shift()
        return { head: parsed.head, next: { kind: 'passthrough' } }
      }
      if (parsed.status >= 100 && parsed.status < 200) {
        // Interim response (e.g. 100 Continue): final response for the same request follows.
        return { head: parsed.head, next: { kind: 'detect' } }
      }
      const isHead = this.headRequests.shift() === true
      if (isHead || parsed.status === 204 || parsed.status === 304) {
        return { head: parsed.head, next: { kind: 'detect' } }
      }
      if (parsed.hasUnknownTransferEncoding) {
        return { head: parsed.head, next: { kind: 'passthrough' } }
      }
      if (parsed.chunked) return { head: parsed.head, next: { kind: 'chunk_size' } }
      if (parsed.contentLength !== null) {
        return parsed.contentLength > 0
          ? { head: parsed.head, next: { kind: 'fixed', remaining: parsed.contentLength } }
          : { head: parsed.head, next: { kind: 'detect' } }
      }
      // Close-delimited body (HTTP/1.0 or Connection: close without Content-Length).
      return { head: parsed.head, next: { kind: 'passthrough' } }
    })
  }

  clientToHost(data: Uint8Array): Uint8Array[] {
    return this.requests.push(data)
  }

  flushClientToHost(): Uint8Array[] {
    return this.requests.flush()
  }

  hostToClient(data: Uint8Array): Uint8Array[] {
    return this.responses.push(data)
  }

  flushHostToClient(): Uint8Array[] {
    return this.responses.flush()
  }
}
