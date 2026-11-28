// Diagnostics per agent and for the host: recent ACP traffic, stderr and process events in memory
// for an exported bundle, and the same written to the log files. Traffic reaches a file only while
// detailed records are on, as it holds prompts, code and tool output.

import type { AgentId } from '@shared/thread'
import type { TrafficRecord } from '@shared/agent-host'
import { sideLog, verboseRecords, writeLog, type SideLog } from '@shared/log/process-log'
import { Ring, TextRing } from './ring'

export const TRAFFIC_MESSAGES = 2_000
export const TRAFFIC_BYTES = 8 * 1024 * 1024
export const STDERR_CHARS = 64 * 1024
const MESSAGE_PREVIEW_CHARS = 256 * 1024
const EVENTS = 500
const LOG_ENTRIES = 2_000
const STDERR_LINE_CHARS = 16 * 1024
/** How many kinds of ignored messages are counted at once; past it the counts are written. */
const IGNORED_KINDS = 200

/** Messages of one kind an agent sent that Kettu does not use, since the turn began. */
interface IgnoredKind {
  sessionId: string | null
  what: string
  count: number
}

interface StoredTraffic {
  at: number
  direction: 'in' | 'out'
  method: string | null
  size: number
  // Kept as JSON text: far smaller than the object graph, and parsed only on export.
  json: string
}

interface PendingStreamDelta {
  direction: 'in' | 'out'
  method: string | null
  kind: string
  startedAt: number
  endedAt: number
  count: number
  chars: number
}

export interface AgentEvent {
  at: number
  event: string
  detail?: string
}

export interface LogEntry {
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

class AgentBuffers {
  readonly traffic = new Ring<StoredTraffic>(TRAFFIC_MESSAGES, TRAFFIC_BYTES)
  readonly stderr = new TextRing(STDERR_CHARS)
  readonly events = new Ring<AgentEvent>(EVENTS)
  readonly stderrFile: SideLog
  readonly trafficFile: SideLog
  // The end of the last stderr chunk, until its line ends.
  partial = ''
  // Adjacent high-frequency streaming text/thought deltas coalesced while verbose logging is off.
  pendingDelta: PendingStreamDelta | null = null

  constructor(agentId: AgentId) {
    this.stderrFile = sideLog('agent', `agent-${agentId}`)
    this.trafficFile = sideLog('verbose', `agent-${agentId}`)
  }
}

function methodOf(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const method = (message as { method?: unknown }).method
  return typeof method === 'string' ? method : null
}

/**
 * Recognizes high-frequency token/chunk streaming notifications whose individual payloads would
 * otherwise trigger hundreds of `JSON.stringify` allocations per second and evict control-plane
 * RPCs from the traffic ring buffer.
 */
function streamDeltaInfo(message: unknown): { kind: string; chars: number } | null {
  if (!isRecord(message)) return null
  // Claude Code SDK partial stream events (`includePartialMessages: true`).
  if (message.type === 'stream_event' && isRecord(message.event)) {
    const event = message.event
    if (event.type === 'content_block_delta') {
      const delta = isRecord(event.delta) ? event.delta : null
      const deltaType = typeof delta?.type === 'string' ? delta.type : 'delta'
      const text =
        typeof delta?.text === 'string'
          ? delta.text
          : typeof delta?.thinking === 'string'
            ? delta.thinking
            : typeof delta?.partial_json === 'string'
              ? delta.partial_json
              : ''
      return { kind: `stream_event/${deltaType}`, chars: text.length }
    }
    return null
  }
  const method = typeof message.method === 'string' ? message.method : null
  if (!method || 'id' in message) return null
  // ACP token chunks inside `session/update`.
  if (method === 'session/update' && isRecord(message.params) && isRecord(message.params.update)) {
    const update = message.params.update
    const kind = update.sessionUpdate
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = isRecord(update.content) ? update.content : null
      const chars = typeof content?.text === 'string' ? content.text.length : 0
      return { kind: `session/update/${kind}`, chars }
    }
    return null
  }
  // Codex item streaming deltas (e.g. `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`).
  if (/^item\/.+\/(?:delta|.*Delta)$/.test(method)) {
    const params = isRecord(message.params) ? message.params : null
    const chars = typeof params?.delta === 'string' ? params.delta.length : 0
    return { kind: method, chars }
  }
  return null
}

const REDACTED = '<redacted>'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{ name, value }` pairs with every value masked. */
function maskedPairs(list: unknown): unknown {
  if (!Array.isArray(list)) return list
  return list.map((item: unknown) => (isRecord(item) ? { ...item, value: REDACTED } : item))
}

/** A record of names to values with every value masked. */
function maskedRecord(record: unknown): unknown {
  if (!isRecord(record)) return record
  return Object.fromEntries(Object.keys(record).map((key) => [key, REDACTED]))
}

/**
 * The message without the values of the headers and environment its MCP servers carry: the
 * artifacts service's session tokens and the keys of the Marketplace's servers. Masked by where
 * they sit, ACP's `params.mcpServers` and Codex's `params.config.mcp_servers`, whatever they hold,
 * and the token of the Kettu service in `params._meta` that Kettu's extension in Pi takes.
 */
function redacted(message: unknown): unknown {
  if (!isRecord(message) || !isRecord(message.params)) return message
  const params = message.params
  let masked = params
  if (Array.isArray(params.mcpServers)) {
    masked = {
      ...masked,
      mcpServers: params.mcpServers.map((server: unknown) =>
        isRecord(server)
          ? {
              ...server,
              ...('headers' in server ? { headers: maskedPairs(server.headers) } : {}),
              ...('env' in server ? { env: maskedPairs(server.env) } : {}),
            }
          : server,
      ),
    }
  }
  const config = params.config
  if (isRecord(config) && isRecord(config.mcp_servers)) {
    const servers = Object.fromEntries(
      Object.entries(config.mcp_servers).map(([name, server]) => [
        name,
        isRecord(server)
          ? {
              ...server,
              ...('http_headers' in server
                ? { http_headers: maskedRecord(server.http_headers) }
                : {}),
              ...('env' in server ? { env: maskedRecord(server.env) } : {}),
            }
          : server,
      ]),
    )
    masked = { ...masked, config: { ...config, mcp_servers: servers } }
  }
  return masked === params ? message : { ...message, params: masked }
}

function ignoredDetail(sessionId: string | null, what: string): string {
  return sessionId ? `${what} (session ${sessionId})` : what
}

export interface DiagnosticsOptions {
  /** Mirrors ACP traffic to stdout, for `KETTU_ACP_LOG=1` in development. */
  mirrorTraffic?: boolean
  write?: (line: string) => void
  now?: () => number
}

export class Diagnostics {
  private agents = new Map<AgentId, AgentBuffers>()
  private ignoredKinds = new Map<AgentId, Map<string, IgnoredKind>>()
  private logRing = new Ring<LogEntry>(LOG_ENTRIES)
  private listeners = new Set<(entry: LogEntry) => void>()
  private readonly now: () => number

  constructor(private readonly options: DiagnosticsOptions = {}) {
    this.now = options.now ?? Date.now
  }

  private buffers(agentId: AgentId): AgentBuffers {
    let buffers = this.agents.get(agentId)
    if (!buffers) {
      buffers = new AgentBuffers(agentId)
      this.agents.set(agentId, buffers)
    }
    return buffers
  }

  private flushPendingDelta(buffers: AgentBuffers): void {
    const pending = buffers.pendingDelta
    if (!pending) return
    buffers.pendingDelta = null
    const json = JSON.stringify({
      coalesced: true,
      kind: pending.kind,
      count: pending.count,
      chars: pending.chars,
      startedAt: pending.startedAt,
      endedAt: pending.endedAt,
    })
    buffers.traffic.push(
      {
        at: pending.startedAt,
        direction: pending.direction,
        method: pending.method,
        size: json.length,
        json,
      },
      json.length,
    )
  }

  traffic(agentId: AgentId, direction: 'in' | 'out', message: unknown): void {
    const buffers = this.buffers(agentId)
    const verbose = verboseRecords()
    if (!verbose && !this.options.mirrorTraffic) {
      const delta = streamDeltaInfo(message)
      if (delta) {
        const now = this.now()
        const method = methodOf(message)
        const pending = buffers.pendingDelta
        if (pending && pending.direction === direction && pending.kind === delta.kind) {
          pending.count++
          pending.chars += delta.chars
          pending.endedAt = now
          return
        }
        this.flushPendingDelta(buffers)
        buffers.pendingDelta = {
          direction,
          method,
          kind: delta.kind,
          startedAt: now,
          endedAt: now,
          count: 1,
          chars: delta.chars,
        }
        return
      }
    }
    this.flushPendingDelta(buffers)
    let json: string
    try {
      json = JSON.stringify(redacted(message)) ?? 'null'
    } catch {
      json = '"<unserializable message>"'
    }
    const size = json.length
    const stored =
      size > MESSAGE_PREVIEW_CHARS
        ? JSON.stringify({ truncated: true, size, preview: json.slice(0, MESSAGE_PREVIEW_CHARS) })
        : json
    const record: StoredTraffic = {
      at: this.now(),
      direction,
      method: methodOf(message),
      size,
      json: stored,
    }
    buffers.traffic.push(record, stored.length)
    if (verbose) {
      buffers.trafficFile.write('traffic', record.method ?? 'message', {
        direction,
        size,
        message: JSON.parse(stored) as unknown,
      })
    }
    if (this.options.mirrorTraffic) {
      const arrow = direction === 'in' ? '<-' : '->'
      ;(this.options.write ?? ((line: string) => process.stdout.write(`${line}\n`)))(
        `[acp ${agentId}] ${arrow} ${stored}`,
      )
    }
  }

  stderr(agentId: AgentId, text: string): void {
    const buffers = this.buffers(agentId)
    buffers.stderr.push(text)
    const lines = (buffers.partial + text).split(/\r?\n/)
    buffers.partial = lines.pop() ?? ''
    // A line that never ends is written in pieces rather than held without bound.
    if (buffers.partial.length > STDERR_LINE_CHARS) {
      lines.push(buffers.partial)
      buffers.partial = ''
    }
    for (const line of lines) if (line.length > 0) buffers.stderrFile.write('stderr', line)
  }

  stderrText(agentId: AgentId): TextRing {
    return this.buffers(agentId).stderr
  }

  event(agentId: AgentId, event: string, detail?: string): void {
    writeLog('info', `agent ${agentId}`, event, detail !== undefined ? { detail } : undefined)
    this.buffers(agentId).events.push({
      at: this.now(),
      event,
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  /**
   * Something the agent sent that Kettu does not use: the first of its kind in a session's turn is
   * an event, and the rest are counted until `turnEnded`, so a stream of them, such as Claude
   * Code's thinking tokens, does not push the agent's other events out of the log and reports.
   */
  ignored(agentId: AgentId, sessionId: string | null, what: string): void {
    let kinds = this.ignoredKinds.get(agentId)
    if (!kinds) {
      kinds = new Map()
      this.ignoredKinds.set(agentId, kinds)
    }
    const key = `${sessionId ?? ''}\n${what}`
    const kind = kinds.get(key)
    if (kind) {
      kind.count++
      return
    }
    if (kinds.size >= IGNORED_KINDS) this.writeIgnored(agentId, () => true)
    kinds.set(key, { sessionId, what, count: 1 })
    this.event(agentId, 'ignored', ignoredDetail(sessionId, what))
  }

  /** A turn of the session ended: writes how many of each kind it ignored, and of no session. */
  turnEnded(agentId: AgentId, sessionIds: readonly string[]): void {
    this.writeIgnored(
      agentId,
      (kind) => kind.sessionId === null || sessionIds.includes(kind.sessionId),
    )
  }

  private writeIgnored(agentId: AgentId, which: (kind: IgnoredKind) => boolean): void {
    const kinds = this.ignoredKinds.get(agentId)
    if (!kinds) return
    for (const [key, kind] of kinds) {
      if (!which(kind)) continue
      kinds.delete(key)
      if (kind.count > 1) {
        this.event(
          agentId,
          'ignored',
          `${ignoredDetail(kind.sessionId, kind.what)}, ${kind.count} in all`,
        )
      }
    }
  }

  log(level: LogEntry['level'], message: string): void {
    writeLog(level, 'host', message)
    const entry = { at: this.now(), level, message }
    this.logRing.push(entry)
    for (const listener of this.listeners) listener(entry)
  }

  onLog(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  logEntries(): LogEntry[] {
    return this.logRing.toArray()
  }

  /** The agent's recent process events alone, which cost no parsing of its traffic. */
  agentEvents(agentId: AgentId): AgentEvent[] {
    return this.agents.get(agentId)?.events.toArray() ?? []
  }

  agentRecords(agentId: AgentId): {
    traffic: TrafficRecord[]
    stderr: string
    events: AgentEvent[]
  } {
    const buffers = this.buffers(agentId)
    this.flushPendingDelta(buffers)
    return {
      traffic: buffers.traffic.toArray().map((record) => ({
        at: record.at,
        direction: record.direction,
        method: record.method,
        size: record.size,
        message: JSON.parse(record.json) as unknown,
      })),
      stderr: buffers.stderr.toString(),
      events: buffers.events.toArray(),
    }
  }
}
