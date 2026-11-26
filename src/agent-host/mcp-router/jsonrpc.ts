// The JSON-RPC messages the router forwards, read without trusting either side, and the parts of
// MCP's two eras it tells apart: the stateful protocols up to 2025-11-25, which open with
// `initialize`, and the stateless 2026-07-28 one, whose every request names its version in `_meta`.

export type Id = string | number

export interface Request {
  jsonrpc: '2.0'
  id: Id
  method: string
  params?: Record<string, unknown>
}

export interface Notification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface Response {
  jsonrpc: '2.0'
  id: Id | null
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

export type Message = Request | Notification | Response

export type Era = 'legacy' | 'modern'

export const MODERN_VERSION = '2026-07-28'
export const LEGACY_VERSION = '2025-11-25'

export const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
export const META_CLIENT = 'io.modelcontextprotocol/clientInfo'
export const META_SERVER = 'io.modelcontextprotocol/serverInfo'
export const META_SUBSCRIPTION = 'io.modelcontextprotocol/subscriptionId'

export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603
/**
 * What the router answers when the server cannot be reached or started; JSON-RPC's server
 * range.
 */
export const SERVER_UNAVAILABLE = -32000

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is Id {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

/** A message as JSON-RPC 2.0 has it, or null for anything else, a batch included. */
export function readMessage(value: unknown): Message | null {
  if (!isRecord(value) || value.jsonrpc !== '2.0') return null
  if (value.params !== undefined && !isRecord(value.params)) return null
  if (typeof value.method === 'string') {
    if (value.id === undefined) return value as unknown as Notification
    return isId(value.id) ? (value as unknown as Request) : null
  }
  if (value.id !== null && !isId(value.id)) return null
  if (value.result !== undefined && !isRecord(value.result)) return null
  if (value.error !== undefined) {
    const error = value.error
    if (!isRecord(error) || typeof error.code !== 'number' || typeof error.message !== 'string') {
      return null
    }
  }
  if ((value.result === undefined) === (value.error === undefined)) return null
  return value as unknown as Response
}

export function isRequest(message: Message): message is Request {
  return 'method' in message && 'id' in message && message.id !== undefined
}

export function isNotification(message: Message): message is Notification {
  return 'method' in message && !('id' in message && message.id !== undefined)
}

export function isResponse(message: Message): message is Response {
  return !('method' in message)
}

export function errorResponse(id: Id | null, code: number, message: string): Response {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export function resultResponse(id: Id, result: Record<string, unknown>): Response {
  return { jsonrpc: '2.0', id, result }
}

export function metaOf(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const meta = params?._meta
  return isRecord(meta) ? meta : {}
}

/** The era a client's request speaks: `initialize` opens the old one, `_meta` names the new. */
export function requestEra(request: Request): Era | null {
  if (request.method === 'initialize') return 'legacy'
  return typeof metaOf(request.params)[META_VERSION] === 'string' ? 'modern' : null
}

/** Whether an error to `initialize` says the server only speaks the stateless protocol. */
export function refusesLegacy(error: Response['error']): boolean {
  if (!error) return false
  const data = isRecord(error.data) ? error.data : {}
  const supported = Array.isArray(data.supported) ? data.supported : []
  return supported.includes(MODERN_VERSION) || error.message.includes(MODERN_VERSION)
}

/** The earlier of two protocol versions, which are dates and compare as text. */
export function earlierVersion(a: string, b: string): string {
  return a < b ? a : b
}

/** The lists the router keeps a server's last answer to, so a session can start without it. */
export const LIST_METHODS = [
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
] as const
export type ListMethod = (typeof LIST_METHODS)[number]

export function isListMethod(method: string): method is ListMethod {
  return (LIST_METHODS as readonly string[]).includes(method)
}

/** What a list_changed notification makes stale. */
export const LIST_CHANGED: Readonly<Record<string, readonly ListMethod[]>> = {
  'notifications/tools/list_changed': ['tools/list'],
  'notifications/prompts/list_changed': ['prompts/list'],
  'notifications/resources/list_changed': ['resources/list', 'resources/templates/list'],
}

/**
 * The methods a client may send to a process other sessions share: what it offers, never what
 * changes the connection for everyone, such as its log level.
 */
export function sharedMethod(method: string): boolean {
  return (
    method === 'ping' ||
    method === 'completion/complete' ||
    method.startsWith('tools/') ||
    method.startsWith('resources/') ||
    method.startsWith('prompts/')
  )
}
