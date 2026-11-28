// `network.fetch`: the one way a plugin's script reaches the network. It reaches only the domains
// its `network:<domain>` permissions name, over https on the default port, with no redirect
// followed and no address on this computer or a private network, so what the plugin was granted
// is all it can reach. Direct connections filter resolved addresses through `publicLookup`;
// proxied connections honor Settings › Advanced or environment proxy variables (and `NO_PROXY`)
// via Node.js's proxy agent while still rejecting loopback, private IP, and local/internal hosts
// before tunneling.

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import type { Platform } from '@shared/platform'
import { customUrlOrigin } from '@shared/plugin-bot-channels'
import { domainCovers } from '@shared/plugins'
import type { Env } from '../find-command'
import { proxyEnvFor } from '../proxy-fetch'
import { grantedDomains, type PluginApiCall } from './call'

export const FETCH_URL_CHARS = 2048
export const FETCH_REQUEST_BYTES = 256 * 1024
export const FETCH_RESPONSE_BYTES = 256 * 1024
export const FETCH_TIMEOUT_MS = 20_000
export const FETCH_MIN_TIMEOUT_MS = 1_000
export const FETCH_MAX_TIMEOUT_MS = 60_000
const MAX_HEADERS = 50
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/
// The connection's own fields, which the transport sets.
const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'expect',
  'proxy-authorization',
  'proxy-connection',
])
// As the manifest writes a domain: lowercase labels and a letters-only last one.
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
// Reserved and local-only host suffixes that never name a public internet service, so a plugin
// cannot reach local or internal hosts even when a proxy resolves names for it.
const PRIVATE_HOST_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'localdomain',
  'home.arpa',
  'in-addr.arpa',
  'ip6.arpa',
] as const

export interface HttpRequest {
  url: URL
  method: string
  headers: Record<string, string>
  body: string | null
  signal: AbortSignal
}

export interface HttpResponse {
  status: number
  /** Lowercase names; a header sent more than once is joined with ", ". */
  headers: Record<string, string>
  /** The body as UTF-8 text. */
  body: string
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>

export interface HttpsTransportOptions {
  /** Reads the agents' environment (Settings › Advanced proxy or shell env) at each request. */
  env?: () => Env
  platform?: Platform
  /** Overrides direct DNS resolution; `publicLookup()` by default. */
  lookup?: LookupFunction
  /** Extra CA certificates for TLS verification (used in tests with a local HTTPS server). */
  ca?: string | Buffer | Array<string | Buffer>
}

// 198.18/15 is left out: proxy tools in fake-IP mode answer every name from it and route what
// follows, so blocking it would cut off every user of one.
const PRIVATE = new BlockList()
for (const [network, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(network, bits, 'ipv4')
}
for (const [network, bits] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(network, bits, 'ipv6')
}

/** Whether an address is outside this computer and its private networks, so a plugin may reach it. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

function normalizeHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
}

/**
 * Whether a host name itself may be reached by a plugin: neither a loopback/private IP literal
 * nor a reserved local/internal name. Direct connections also filter resolved addresses through
 * `publicLookup`; proxied connections rely on this check because the proxy resolves the name.
 */
export function isPublicHost(hostname: string): boolean {
  const host = normalizeHost(hostname)
  if (host === '') return false
  const address = host.split('%', 1)[0]!
  if (isIP(address) !== 0) return isPublicAddress(address)
  return !PRIVATE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

type Resolve = (
  hostname: string,
  options: dns.LookupOptions & { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void

/** A lookup that resolves as usual and then keeps only the public addresses, or fails. */
export function publicLookup(resolve: Resolve = dns.lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error, '', 0)
      const allowed = addresses.filter((item) => isPublicAddress(item.address))
      const first = allowed[0]
      if (!first) {
        const refused = new Error(
          `${hostname} resolves to an address on this computer or a private network`,
        ) as NodeJS.ErrnoException
        refused.code = 'EACCES'
        return callback(refused, '', 0)
      }
      if (options.all) return callback(null, allowed)
      callback(null, first.address, first.family)
    })
  }
}

/**
 * Sends the request over https, through the agents' proxy when one applies (from Settings ›
 * Advanced or the environment) and directly to a public address otherwise, reading at most
 * `FETCH_RESPONSE_BYTES`.
 */
export function createHttpsTransport(options: HttpsTransportOptions = {}): HttpTransport {
  const platform = options.platform ?? (process.platform as Platform)
  const lookup = options.lookup ?? publicLookup()
  return (request) => {
    // Node.js skips `lookup` when connecting directly to an IP literal, so reject non-public IP
    // literals up front regardless of proxy settings.
    const hostAddress = normalizeHost(request.url.hostname).split('%', 1)[0]!
    if (isIP(hostAddress) !== 0 && !isPublicAddress(hostAddress)) {
      return Promise.reject(
        new Error(`${request.url.hostname} is on this computer or a private network`),
      )
    }
    const proxyEnv = options.env ? proxyEnvFor(request.url, options.env(), platform) : null
    if (proxyEnv && !isPublicHost(request.url.hostname)) {
      return Promise.reject(
        new Error(`${request.url.hostname} is on this computer or a private network`),
      )
    }
    if (request.signal.aborted) {
      return Promise.reject(request.signal.reason)
    }
    return new Promise((resolve, reject) => {
      let settled = false
      // Node.js's https.Agent({ proxyEnv }) honors NO_PROXY per request: proxied targets tunnel
      // through the proxy (which resolves the target name, while connecting to the proxy itself
      // without our `lookup`), and bypassed targets fall back to a direct TLS connection using
      // `lookup` (so `publicLookup` still blocks loopback and private-network resolutions).
      const agent = proxyEnv ? new https.Agent({ proxyEnv, keepAlive: false }) : false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', onAbort)
        if (agent) agent.destroy()
        callback()
      }
      const onAbort = (): void => {
        const reason = request.signal.reason
        outgoing.destroy(reason instanceof Error ? reason : undefined)
        finish(() => reject(reason))
      }
      const outgoing = https.request(
        request.url,
        {
          method: request.method,
          headers: request.headers,
          lookup,
          agent,
          signal: request.signal,
          ...(options.ca !== undefined ? { ca: options.ca } : {}),
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          const tooLarge = (): void => {
            response.destroy()
            finish(() =>
              reject(new Error(`The response is larger than ${FETCH_RESPONSE_BYTES / 1024} KB`)),
            )
          }
          if (Number(response.headers['content-length']) > FETCH_RESPONSE_BYTES) return tooLarge()
          const encoding = response.headers['content-encoding']
          if (typeof encoding === 'string' && encoding.toLowerCase() !== 'identity') {
            response.destroy()
            return finish(() =>
              reject(new Error(`The response is encoded as ${encoding.slice(0, 40)}`)),
            )
          }
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > FETCH_RESPONSE_BYTES) return tooLarge()
            chunks.push(chunk)
          })
          response.on('error', (error) => finish(() => reject(error)))
          response.on('end', () => {
            const headers: Record<string, string> = {}
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined) {
                headers[name] = Array.isArray(value) ? value.join(', ') : value
              }
            }
            finish(() =>
              resolve({
                status: response.statusCode ?? 0,
                headers,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            )
          })
        },
      )
      request.signal.addEventListener('abort', onAbort, { once: true })
      outgoing.on('error', (error) => finish(() => reject(error)))
      outgoing.end(request.body ?? undefined)
    })
  }
}

/** Sends the request directly over https, to a public address, and reads at most `FETCH_RESPONSE_BYTES`. */
export const httpsTransport: HttpTransport = createHttpsTransport()

/**
 * Sends a request to a user-configured custom origin (`network.custom`), allowing http or https,
 * custom ports and private/loopback addresses explicitly entered in the plugin's URL settings.
 */
export function createCustomHttpTransport(options: HttpsTransportOptions = {}): HttpTransport {
  const platform = options.platform ?? (process.platform as Platform)
  return (request) => {
    if (request.signal.aborted) {
      return Promise.reject(request.signal.reason)
    }
    const isHttps = request.url.protocol === 'https:'
    const proxyEnv = options.env ? proxyEnvFor(request.url, options.env(), platform) : null
    return new Promise((resolve, reject) => {
      let settled = false
      const agent = proxyEnv
        ? isHttps
          ? new https.Agent({ proxyEnv, keepAlive: false })
          : new http.Agent({ proxyEnv, keepAlive: false })
        : false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', onAbort)
        if (agent) agent.destroy()
        callback()
      }
      const onAbort = (): void => {
        const reason = request.signal.reason
        outgoing.destroy(reason instanceof Error ? reason : undefined)
        finish(() => reject(reason))
      }
      const handleResponse = (response: http.IncomingMessage): void => {
        const chunks: Buffer[] = []
        let size = 0
        const tooLarge = (): void => {
          response.destroy()
          finish(() =>
            reject(new Error(`The response is larger than ${FETCH_RESPONSE_BYTES / 1024} KB`)),
          )
        }
        if (Number(response.headers['content-length']) > FETCH_RESPONSE_BYTES) return tooLarge()
        const encoding = response.headers['content-encoding']
        if (typeof encoding === 'string' && encoding.toLowerCase() !== 'identity') {
          response.destroy()
          return finish(() =>
            reject(new Error(`The response is encoded as ${encoding.slice(0, 40)}`)),
          )
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > FETCH_RESPONSE_BYTES) return tooLarge()
          chunks.push(chunk)
        })
        response.on('error', (error) => finish(() => reject(error)))
        response.on('end', () => {
          const headers: Record<string, string> = {}
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined) {
              headers[name] = Array.isArray(value) ? value.join(', ') : value
            }
          }
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        })
      }
      const outgoing = isHttps
        ? https.request(
            request.url,
            {
              method: request.method,
              headers: request.headers,
              agent,
              signal: request.signal,
              ...(options.ca !== undefined ? { ca: options.ca } : {}),
            },
            handleResponse,
          )
        : http.request(
            request.url,
            {
              method: request.method,
              headers: request.headers,
              agent,
              signal: request.signal,
            },
            handleResponse,
          )
      request.signal.addEventListener('abort', onAbort, { once: true })
      outgoing.on('error', (error) => finish(() => reject(error)))
      outgoing.end(request.body ?? undefined)
    })
  }
}

export const customHttpTransport: HttpTransport = createCustomHttpTransport()

/** Checks whether a URL is authorized by the plugin's `network:<domain>` or `network.custom` grants. */
export function checkPluginNetworkTarget(
  url: URL,
  permissions: readonly string[],
  customOrigins: readonly string[],
  protocols: { public: string; custom: readonly string[] },
): { custom: boolean } {
  if (url.username !== '' || url.password !== '') {
    throw new Error('An address with a user name or password cannot be reached')
  }
  const normalized = customUrlOrigin(url.toString())
  if (
    permissions.includes('network.custom') &&
    protocols.custom.includes(url.protocol) &&
    normalized !== null &&
    customOrigins.includes(normalized)
  ) {
    return { custom: true }
  }
  if (url.protocol !== protocols.public) {
    throw new Error(`Only ${protocols.public.slice(0, -1)} addresses can be reached`)
  }
  if (url.port !== '') {
    throw new Error(`Only the default ${protocols.public.slice(0, -1)} port can be reached`)
  }
  const host = url.hostname
  const domains = grantedDomains(permissions)
  if (!HOST_NAME.test(host) || !domains.some((domain) => domainCovers(domain, host))) {
    throw new Error(
      `${host} is not among the domains this plugin may reach (${domains.join(', ')}). ` +
        `It needs the permission "network:${host}" or a configured URL setting with "network.custom".`,
    )
  }
  if (!isPublicHost(host)) {
    throw new Error(`${host} is on this computer or a private network`)
  }
  return { custom: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sentHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (value === undefined) return out
  if (!isRecord(value) || Object.keys(value).length > MAX_HEADERS) {
    throw new Error(`headers must be an object of at most ${MAX_HEADERS} strings`)
  }
  for (const [name, text] of Object.entries(value)) {
    if (!HEADER_NAME.test(name) || typeof text !== 'string' || text.length > 8192) {
      throw new Error(`The header "${name.slice(0, 100)}" is not a name and a string`)
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(`The header "${name}" is set by Kettu`)
    }
    out[name.toLowerCase()] = text
  }
  return out
}

export interface NetworkFetchOptions {
  /** User-configured origins from `url` settings for plugins holding `network.custom`. */
  customOrigins?: (pluginId: string) => readonly string[]
  /** Transport used for `network.custom` origins (allows http/custom ports/private hosts). */
  customTransport?: HttpTransport
}

/** The call's checks and its answer; `transport` sends the request that passed them. */
export function networkFetch(
  transport: HttpTransport,
  fetchOptions: NetworkFetchOptions = {},
): PluginApiCall {
  return {
    permission: 'network',
    async run({ pluginId, permissions }, [target, init]) {
      if (typeof target !== 'string' || target.length > FETCH_URL_CHARS) {
        throw new Error(`The address must be text of at most ${FETCH_URL_CHARS} characters`)
      }
      const url = URL.parse(target)
      if (url === null) throw new Error('The address is not a valid URL')
      const origins = fetchOptions.customOrigins?.(pluginId) ?? []
      const { custom } = checkPluginNetworkTarget(url, permissions, origins, {
        public: 'https:',
        custom: ['https:', 'http:'],
      })
      if (init !== undefined && !isRecord(init)) throw new Error('The options must be an object')
      const options = init ?? {}
      if (options.method !== undefined && typeof options.method !== 'string') {
        throw new Error('The method must be text')
      }
      const method = options.method?.toUpperCase() ?? 'GET'
      if (!(METHODS as readonly string[]).includes(method)) {
        throw new Error(`The method must be one of ${METHODS.join(', ')}`)
      }
      const body = options.body
      if (body !== undefined && typeof body !== 'string') throw new Error('The body must be text')
      if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
        throw new Error(`A ${method} request has no body`)
      }
      if (body !== undefined && Buffer.byteLength(body) > FETCH_REQUEST_BYTES) {
        throw new Error(`The body is larger than ${FETCH_REQUEST_BYTES / 1024} KB`)
      }
      let timeoutMs = FETCH_TIMEOUT_MS
      if (options.timeoutMs !== undefined) {
        if (
          typeof options.timeoutMs !== 'number' ||
          !Number.isFinite(options.timeoutMs) ||
          options.timeoutMs < FETCH_MIN_TIMEOUT_MS ||
          options.timeoutMs > FETCH_MAX_TIMEOUT_MS
        ) {
          throw new Error(
            `timeoutMs must be between ${FETCH_MIN_TIMEOUT_MS} and ${FETCH_MAX_TIMEOUT_MS}`,
          )
        }
        timeoutMs = Math.round(options.timeoutMs)
      }
      const headers = {
        'user-agent': 'Kettu',
        'accept-encoding': 'identity',
        ...sentHeaders(options.headers),
      }
      const activeTransport = custom
        ? (fetchOptions.customTransport ?? customHttpTransport)
        : transport
      return activeTransport({
        url,
        method,
        headers,
        body: body ?? null,
        signal: AbortSignal.timeout(timeoutMs),
      })
    },
  }
}
