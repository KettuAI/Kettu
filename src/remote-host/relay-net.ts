// How the remote host reaches relays. A region under the main relay's domain is an https or wss
// URL like any, checked by the system's trust store. A region at an IP address is reached only
// through the pin its signed list gives: the SHA-256 of its certificate's SubjectPublicKeyInfo,
// whatever the certificate's issuer, name or dates.

import { createHash, type X509Certificate } from 'node:crypto'
import https from 'node:https'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import { WebSocket as WsWebSocket } from 'ws'
import { MAX_RELAY_MESSAGE, encodeRelayBytes } from '@shared/remote/relay'

/** The pin of a certificate: the base64url SHA-256 of its SubjectPublicKeyInfo in DER. */
export function certificatePin(certificate: X509Certificate): string {
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' })
  return encodeRelayBytes(createHash('sha256').update(spki).digest())
}

export class PinMismatch extends Error {
  constructor(where: string) {
    super(`${where} did not show the pinned certificate`)
    this.name = 'PinMismatch'
  }
}

/**
 * A TLS connection that is ended before anything is sent on it unless the server's certificate
 * has the pinned key: Node.js emits `secureConnect` in the same turn as it would refuse a
 * certificate it does not trust, before the data written meanwhile goes out.
 */
export function pinnedConnect(options: tls.ConnectionOptions, pin: string): tls.TLSSocket {
  const host = options.host ?? 'localhost'
  const socket = tls.connect({
    ...options,
    host,
    // The pin alone vouches for the server; there is no name to check at an IP address.
    rejectUnauthorized: false,
    servername: net.isIP(host) ? '' : (options.servername ?? host),
  })
  socket.once('secureConnect', () => {
    const certificate = socket.getPeerX509Certificate()
    if (certificate && certificatePin(certificate) === pin) return
    socket.destroy(new PinMismatch(`${host}:${options.port}`))
  })
  return socket
}

/** Keeps connections to one pinned region open between requests, for timing a warm one. */
class PinnedAgent extends https.Agent {
  constructor(private readonly pin: string) {
    super({ keepAlive: true, maxSockets: 2 })
  }

  override createConnection(options: https.RequestOptions): Duplex {
    return pinnedConnect(options as tls.ConnectionOptions, this.pin)
  }
}

const agents = new Map<string, PinnedAgent>()

function agentFor(url: URL, pin: string): PinnedAgent {
  const key = `${url.origin} ${pin}`
  let agent = agents.get(key)
  if (!agent) agents.set(key, (agent = new PinnedAgent(pin)))
  return agent
}

/** Opens a WebSocket to a relay: a standard one, or one through the pin when there is one. */
export function openRelaySocket(url: string, pin?: string): WebSocket {
  if (!pin) return new WebSocket(url)
  const socket = new WsWebSocket(url, {
    createConnection: ((options: tls.ConnectionOptions) =>
      pinnedConnect(options, pin)) as unknown as typeof net.createConnection,
    perMessageDeflate: false,
    maxPayload: MAX_RELAY_MESSAGE,
    handshakeTimeout: 15_000,
  })
  // ws emits `error` as an EventEmitter does, which throws without a listener; the close event
  // that follows it is what the callers listen for.
  socket.on('error', () => {})
  return socket as unknown as WebSocket
}

export interface RelayRequest {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  pin?: string
  timeoutMs: number
}

export interface RelayResponse {
  status: number
  header(name: string): string | null
  text: string
}

/** One request to a relay, through its pin when it has one. */
export async function relayRequest(url: string, request: RelayRequest): Promise<RelayResponse> {
  const { method = 'GET', headers = {}, body, pin, timeoutMs } = request
  if (!pin) {
    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return {
      status: response.status,
      header: (name) => response.headers.get(name),
      text: await response.text(),
    }
  }
  const target = new URL(url)
  if (target.protocol !== 'https:') throw new Error('A pinned relay is reached over https alone')
  return new Promise((resolve, reject) => {
    const req = https.request(
      target,
      {
        method,
        headers:
          body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) },
        agent: agentFor(target, pin),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          // A relay's answers are small; a long one is not a relay's.
          if (size > MAX_RELAY_MESSAGE) return req.destroy(new Error('The answer is too long'))
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            header: (name) => {
              const value = res.headers[name.toLowerCase()]
              return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
            },
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('The relay did not answer in time')))
    req.on('error', reject)
    req.end(body)
  })
}

/** Reads JSON from a relay, null for an answer that is none. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
