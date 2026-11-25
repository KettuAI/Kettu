// The host's requests to the internet, through the proxy npm and git take: the custom one from
// Settings › Advanced, else the agents' proxy variables. The platform's fetch reads no proxy, and
// setting the process's proxy would send the host's requests to this computer there too, so a
// proxied request goes through `node:http` with a proxy agent of its own.

import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'
import { pipeline, Readable, type Transform } from 'node:stream'
import zlib from 'node:zlib'
import type { Platform } from '@shared/platform'
import { getEnv, type Env } from './find-command'

export type Fetch = typeof fetch

const MAX_REDIRECTS = 20
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const NULL_BODY = new Set([101, 103, 204, 205, 304])
// What the platform's fetch sends when the caller sets none.
const DEFAULT_HEADERS: Record<string, string> = {
  accept: '*/*',
  'accept-language': '*',
  'sec-fetch-mode': 'cors',
  'user-agent': 'node',
  'accept-encoding': 'gzip, deflate',
}
// Dropped on a redirect to another origin, and with the body on one that turns into a GET.
const ORIGIN_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'host']
const BODY_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
]

const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('0.0.0.0', 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')
LOOPBACK.addAddress('::', 'ipv6')

/** Whether a URL's host is this computer, which a request never reaches through a proxy. */
export function isLoopback(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const family = isIP(host)
  return family !== 0 && LOOPBACK.check(host, family === 4 ? 'ipv4' : 'ipv6')
}

function variable(env: Env, name: string, platform: Platform): string | undefined {
  const value = getEnv(env, name, platform)?.trim() || getEnv(env, name.toLowerCase(), platform)
  return value?.trim() || undefined
}

/**
 * The proxy variables a request to `url` hands Node.js's proxy agent, which also applies
 * NO_PROXY; null when it goes out without one: to this computer, or with no proxy for its scheme.
 */
export function proxyEnvFor(url: URL, env: Env, platform: Platform): Env | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (isLoopback(url.hostname)) return null
  const name = url.protocol === 'https:' ? 'HTTPS_PROXY' : 'HTTP_PROXY'
  const proxy = variable(env, name, platform)
  if (!proxy) return null
  const noProxy = variable(env, 'NO_PROXY', platform)
  return { [name]: proxy, ...(noProxy ? { NO_PROXY: noProxy } : {}) }
}

/**
 * A fetch through the proxy `env` names, read at each request. A request with no proxy to take
 * goes to the platform's fetch as it is.
 */
export function proxyFetch(
  env: () => Env,
  platform: Platform = process.platform as Platform,
): Fetch {
  return (async (input: Parameters<Fetch>[0], init?: RequestInit) => {
    const variables = env()
    const href = input instanceof Request ? input.url : String(input)
    const url = URL.parse(href)
    if (!url || !proxyEnvFor(url, variables, platform)) return globalThis.fetch(input, init)
    return send(new Request(input, init), variables, platform)
  }) as Fetch
}

async function send(request: Request, env: Env, platform: Platform): Promise<Response> {
  const { signal } = request
  signal.throwIfAborted()
  let body = request.body ? Buffer.from(await request.arrayBuffer()) : null
  let method = request.method
  const headers = new Headers(request.headers)
  for (const [name, value] of Object.entries(DEFAULT_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  let url = new URL(request.url)
  for (let redirects = 0; ; redirects++) {
    const answer = await exchange({ url, method, headers, body, env, platform, signal })
    const status = answer.statusCode ?? 0
    const location = answer.headers.location
    if (!REDIRECTS.has(status) || location === undefined || request.redirect === 'manual') {
      return toResponse(answer, url, redirects > 0, method, signal)
    }
    discard(answer)
    if (request.redirect === 'error') throw new TypeError('unexpected redirect')
    if (redirects >= MAX_REDIRECTS) throw new TypeError('redirect count exceeded')
    const next = URL.parse(location, url.href)
    if (!next || (next.protocol !== 'https:' && next.protocol !== 'http:')) {
      throw new TypeError(`The redirect to ${location.slice(0, 200)} is not an http(s) address`)
    }
    if (
      ((status === 301 || status === 302) && method === 'POST') ||
      (status === 303 && method !== 'GET' && method !== 'HEAD')
    ) {
      method = 'GET'
      body = null
      for (const name of BODY_HEADERS) headers.delete(name)
    }
    if (next.origin !== url.origin) for (const name of ORIGIN_HEADERS) headers.delete(name)
    url = next
  }
}

interface Exchange {
  url: URL
  method: string
  headers: Headers
  body: Buffer | null
  env: Env
  platform: Platform
  signal: AbortSignal
}

/** One request, through the proxy its own URL takes, so a redirect can change it. */
function exchange(options: Exchange): Promise<IncomingMessage> {
  const { url, signal } = options
  const client = url.protocol === 'https:' ? https : http
  const proxyEnv = proxyEnvFor(url, options.env, options.platform)
  const agent = new client.Agent(proxyEnv ? { proxyEnv } : {})
  const headers: Record<string, string> = {}
  options.headers.forEach((value, name) => {
    headers[name] = value
  })
  if (options.body) headers['content-length'] = String(options.body.length)
  return new Promise((resolve, reject) => {
    const outgoing = client.request(url, { method: options.method, headers, agent }, (answer) => {
      signal.removeEventListener('abort', abort)
      resolve(answer)
    })
    const abort = (): void => {
      outgoing.destroy(signal.reason as Error)
    }
    signal.addEventListener('abort', abort, { once: true })
    outgoing.on('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(signal.aborted ? signal.reason : new TypeError(error.message, { cause: error }))
    })
    outgoing.end(options.body ?? undefined)
  })
}

function discard(answer: IncomingMessage): void {
  answer.on('error', () => {})
  answer.resume()
}

function toResponse(
  answer: IncomingMessage,
  url: URL,
  redirected: boolean,
  method: string,
  signal: AbortSignal,
): Response {
  const status = answer.statusCode ?? 0
  if (status < 200 || status > 599) {
    answer.destroy()
    throw new TypeError(`The server answered with status ${status}`)
  }
  const headers = new Headers()
  const raw = answer.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      headers.append(raw[i]!, raw[i + 1]!)
    } catch {
      // A value Headers refuses, which the platform's fetch would not pass on either.
    }
  }
  let body: ReadableStream<Uint8Array> | null = null
  if (method === 'HEAD' || NULL_BODY.has(status)) discard(answer)
  else body = webBody(answer, signal)
  let response: Response
  try {
    response = new Response(body, { status, statusText: answer.statusMessage ?? '', headers })
  } catch {
    response = new Response(body, { status, headers })
  }
  Object.defineProperties(response, {
    url: { value: url.href },
    redirected: { value: redirected },
  })
  return response
}

/** The body decoded as the platform's fetch decodes it, ended with the reason of an abort. */
function webBody(answer: IncomingMessage, signal: AbortSignal): ReadableStream<Uint8Array> {
  const decoders = decodersFor(answer.headers['content-encoding'])
  // pipeline hands back its last stream, a decoder, and destroys the others with it.
  const stream: Readable =
    decoders.length === 0 ? answer : (pipeline([answer, ...decoders], () => {}) as Transform)
  const abort = (): void => {
    stream.destroy(signal.reason as Error)
  }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  stream.once('close', () => signal.removeEventListener('abort', abort))
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
}

/** Decoders for a body's codings, last applied first; none when one is unknown, as fetch does. */
function decodersFor(encoding: string | undefined): Transform[] {
  if (!encoding) return []
  const codings = encoding
    .toLowerCase()
    .split(',')
    .map((coding) => coding.trim())
    .filter((coding) => coding !== '' && coding !== 'identity')
    .reverse()
  const decoders: Transform[] = []
  const flush = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH }
  for (const coding of codings) {
    if (coding === 'gzip' || coding === 'x-gzip') decoders.push(zlib.createGunzip(flush))
    else if (coding === 'deflate') decoders.push(zlib.createInflate(flush))
    else if (coding === 'br') {
      decoders.push(
        zlib.createBrotliDecompress({
          flush: zlib.constants.BROTLI_OPERATION_FLUSH,
          finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
        }),
      )
    } else return []
  }
  return decoders
}
