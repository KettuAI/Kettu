// Host-managed WebSocket connections for Kettu plugins (`network.ws.open/send/close`).
// Enforces the same `network:<domain>` public-only allowlist and `network.custom` explicit-origin
// lock as `network.fetch`, caps open sockets and frame sizes per plugin, supports both UTF-8 text
// and base64-encoded binary frames (e.g. Feishu pbbp2 protobuf), and tears down all sockets on unload.

import { randomUUID } from 'node:crypto'
import https from 'node:https'
import WebSocket, { type RawData } from 'ws'
import type { Platform } from '@shared/platform'
import { PLUGIN_WS_EVENTS, PLUGIN_WS_LIMITS } from '@shared/plugin-bot-channels'
import type { Env } from '../find-command'
import { proxyEnvFor } from '../proxy-fetch'
import type { PluginApiCall } from './call'
import { checkPluginNetworkTarget, FETCH_URL_CHARS, publicLookup } from './network'

const MAX_HEADERS = 32
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/
const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'proxy-authorization',
  'proxy-connection',
])

export interface PluginWebSocketsDeps {
  deliver(pluginId: string, event: string, payload: unknown): void
  customOrigins?: (pluginId: string) => readonly string[]
  env?: () => Env
  platform?: Platform
  log?: (level: 'info' | 'warn', message: string) => void
  /** Test seam allowing an alternate WebSocket implementation. */
  createSocket?: (
    url: string,
    protocols: string[] | undefined,
    options: WebSocket.ClientOptions,
  ) => WebSocket
}

interface ManagedSocket {
  id: string
  pluginId: string
  ws: WebSocket
  agent: https.Agent | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw === undefined) return out
  if (!isRecord(raw) || Object.keys(raw).length > MAX_HEADERS) {
    throw new Error(`headers must be an object of at most ${MAX_HEADERS} strings`)
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || value.length > 8192) {
      throw new Error(`Header "${name.slice(0, 100)}" is invalid`)
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(`Header "${name}" is managed by Kettu`)
    }
    out[name] = value
  }
  return out
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

export class PluginWebSockets {
  private readonly sockets = new Map<string, ManagedSocket>()
  private readonly platform: Platform

  constructor(private readonly deps: PluginWebSocketsDeps) {
    this.platform = deps.platform ?? (process.platform as Platform)
  }

  open(pluginId: string, permissions: readonly string[], rawOptions: unknown): { id: string } {
    if (!isRecord(rawOptions) || typeof rawOptions.url !== 'string') {
      throw new Error('options.url must be a WebSocket URL')
    }
    if (rawOptions.url.length > FETCH_URL_CHARS) {
      throw new Error(`URL must be at most ${FETCH_URL_CHARS} characters`)
    }
    const url = URL.parse(rawOptions.url)
    if (!url) throw new Error('The address is not a valid URL')

    let activeForPlugin = 0
    for (const item of this.sockets.values()) {
      if (item.pluginId === pluginId) activeForPlugin++
    }
    if (activeForPlugin >= PLUGIN_WS_LIMITS.maxSockets) {
      throw new Error(`A plugin may hold at most ${PLUGIN_WS_LIMITS.maxSockets} open WebSockets`)
    }

    const origins = this.deps.customOrigins?.(pluginId) ?? []
    const { custom } = checkPluginNetworkTarget(url, permissions, origins, {
      public: 'wss:',
      custom: ['wss:', 'ws:'],
    })

    const headers = parseHeaders(rawOptions.headers)
    let protocols: string[] | undefined
    if (rawOptions.protocols !== undefined) {
      if (
        !Array.isArray(rawOptions.protocols) ||
        rawOptions.protocols.length > 8 ||
        !rawOptions.protocols.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 128)
      ) {
        throw new Error('protocols must be an array of at most 8 non-empty strings')
      }
      protocols = rawOptions.protocols as string[]
    }

    const id = `ws_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const httpEquivalent = new URL(url.toString().replace(/^ws/, 'http'))
    const proxyEnv = this.deps.env
      ? proxyEnvFor(httpEquivalent, this.deps.env(), this.platform)
      : null
    const agent =
      url.protocol === 'wss:' && proxyEnv ? new https.Agent({ proxyEnv, keepAlive: false }) : null

    const clientOptions: WebSocket.ClientOptions = {
      headers,
      maxPayload: PLUGIN_WS_LIMITS.maxFrameBytes,
      handshakeTimeout: 15_000,
      ...(agent ? { agent } : {}),
      ...(!custom && !agent ? { lookup: publicLookup() } : {}),
    }

    const ws = this.deps.createSocket
      ? this.deps.createSocket(url.toString(), protocols, clientOptions)
      : protocols
        ? new WebSocket(url.toString(), protocols, clientOptions)
        : new WebSocket(url.toString(), clientOptions)

    const managed: ManagedSocket = { id, pluginId, ws, agent }
    this.sockets.set(id, managed)

    ws.on('open', () => {
      if (!this.sockets.has(id)) return
      this.deps.deliver(pluginId, PLUGIN_WS_EVENTS.open, { id })
    })

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!this.sockets.has(id)) return
      const buf = rawDataToBuffer(data)
      if (buf.length > PLUGIN_WS_LIMITS.maxFrameBytes) {
        ws.close(1009, 'Frame too large')
        return
      }
      this.deps.deliver(pluginId, PLUGIN_WS_EVENTS.message, {
        id,
        data: isBinary ? buf.toString('base64') : buf.toString('utf8'),
        encoding: isBinary ? 'base64' : 'text',
      })
    })

    ws.on('error', (error: Error) => {
      if (!this.sockets.has(id)) return
      this.deps.deliver(pluginId, PLUGIN_WS_EVENTS.error, {
        id,
        message: error.message.slice(0, 500),
      })
    })

    ws.on('close', (code: number, reason: Buffer) => {
      const removed = this.sockets.get(id)
      if (!removed) return
      this.sockets.delete(id)
      removed.agent?.destroy()
      this.deps.deliver(pluginId, PLUGIN_WS_EVENTS.close, {
        id,
        code,
        reason: reason.toString('utf8').slice(0, 200),
      })
    })

    return { id }
  }

  send(pluginId: string, rawOptions: unknown): null {
    if (
      !isRecord(rawOptions) ||
      typeof rawOptions.id !== 'string' ||
      typeof rawOptions.data !== 'string'
    ) {
      throw new Error('options.id and options.data must be strings')
    }
    const managed = this.sockets.get(rawOptions.id)
    if (!managed || managed.pluginId !== pluginId) {
      throw new Error('Unknown WebSocket id')
    }
    if (managed.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open')
    }
    const encoding = rawOptions.encoding ?? 'text'
    if (encoding !== 'text' && encoding !== 'base64') {
      throw new Error('encoding must be "text" or "base64"')
    }
    const payload = encoding === 'base64' ? Buffer.from(rawOptions.data, 'base64') : rawOptions.data
    const byteLen = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length
    if (byteLen > PLUGIN_WS_LIMITS.maxFrameBytes) {
      throw new Error(`Frame exceeds ${PLUGIN_WS_LIMITS.maxFrameBytes / 1024} KB limit`)
    }
    managed.ws.send(payload)
    return null
  }

  close(pluginId: string, rawOptions: unknown): null {
    if (!isRecord(rawOptions) || typeof rawOptions.id !== 'string') {
      throw new Error('options.id must be a string')
    }
    const managed = this.sockets.get(rawOptions.id)
    if (!managed || managed.pluginId !== pluginId) return null
    const code =
      typeof rawOptions.code === 'number' && Number.isInteger(rawOptions.code)
        ? rawOptions.code
        : 1000
    const reason = typeof rawOptions.reason === 'string' ? rawOptions.reason.slice(0, 120) : ''
    this.sockets.delete(managed.id)
    try {
      managed.ws.close(code, reason)
    } catch {
      managed.ws.terminate()
    }
    managed.agent?.destroy()
    return null
  }

  /** Closes every open WebSocket owned by a plugin (on deactivate, crash, or uninstall). */
  closeAll(pluginId: string): void {
    for (const [id, managed] of [...this.sockets.entries()]) {
      if (managed.pluginId !== pluginId) continue
      this.sockets.delete(id)
      try {
        managed.ws.terminate()
      } catch {
        // Ignore teardown failures.
      }
      managed.agent?.destroy()
    }
  }

  dispose(): void {
    for (const [id, managed] of [...this.sockets.entries()]) {
      this.sockets.delete(id)
      try {
        managed.ws.terminate()
      } catch {
        // Ignore teardown failures.
      }
      managed.agent?.destroy()
    }
  }
}

/** Plugin API calls for host-managed WebSockets. */
export function wsCalls(sockets: PluginWebSockets): Record<string, PluginApiCall> {
  return {
    'network.ws.open': {
      permission: 'network',
      run: ({ pluginId, permissions }, [options]) => sockets.open(pluginId, permissions, options),
    },
    'network.ws.send': {
      permission: 'network',
      run: ({ pluginId }, [options]) => sockets.send(pluginId, options),
    },
    'network.ws.close': {
      permission: 'network',
      run: ({ pluginId }, [options]) => sockets.close(pluginId, options),
    },
  }
}
