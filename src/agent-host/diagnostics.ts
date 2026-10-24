// In-memory diagnostics: ACP traffic, stderr and process events per agent, and the host log.
// Nothing here is written to disk until the user exports a bundle.

import type { AgentId } from '@shared/thread'
import type { TrafficRecord } from '@shared/agent-host'
import { Ring, TextRing } from './ring'

export const TRAFFIC_MESSAGES = 2_000
export const TRAFFIC_BYTES = 8 * 1024 * 1024
export const STDERR_CHARS = 64 * 1024
const MESSAGE_PREVIEW_CHARS = 256 * 1024
const EVENTS = 500
const LOG_ENTRIES = 2_000

interface StoredTraffic {
  at: number
  direction: 'in' | 'out'
  method: string | null
  size: number
  // Kept as JSON text: far smaller than the object graph, and parsed only on export.
  json: string
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
}

function methodOf(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const method = (message as { method?: unknown }).method
  return typeof method === 'string' ? method : null
}

/**
 * The message without the values of its MCP servers' headers, which carry the artifacts service's
 * session tokens; only attach requests hold servers.
 */
function redacted(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) return message
  const params = (message as { params?: unknown }).params
  if (typeof params !== 'object' || params === null) return message
  const servers = (params as { mcpServers?: unknown }).mcpServers
  if (!Array.isArray(servers)) return message
  const mcpServers = servers.map((server: unknown) => {
    const headers = (server as { headers?: unknown } | null)?.headers
    if (!Array.isArray(headers)) return server
    return {
      ...(server as object),
      headers: headers.map((header: unknown) => ({
        ...(header as object),
        value: '<redacted>',
      })),
    }
  })
  return { ...message, params: { ...params, mcpServers } }
}

export interface DiagnosticsOptions {
  /** Mirrors ACP traffic to stdout, for `OVERBENCH_ACP_LOG=1` in development. */
  mirrorTraffic?: boolean
  write?: (line: string) => void
  now?: () => number
}

export class Diagnostics {
  private agents = new Map<AgentId, AgentBuffers>()
  private logRing = new Ring<LogEntry>(LOG_ENTRIES)
  private listeners = new Set<(entry: LogEntry) => void>()
  private readonly now: () => number

  constructor(private readonly options: DiagnosticsOptions = {}) {
    this.now = options.now ?? Date.now
  }

  private buffers(agentId: AgentId): AgentBuffers {
    let buffers = this.agents.get(agentId)
    if (!buffers) {
      buffers = new AgentBuffers()
      this.agents.set(agentId, buffers)
    }
    return buffers
  }

  traffic(agentId: AgentId, direction: 'in' | 'out', message: unknown): void {
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
    this.buffers(agentId).traffic.push(record, stored.length)
    if (this.options.mirrorTraffic) {
      const arrow = direction === 'in' ? '<-' : '->'
      ;(this.options.write ?? ((line: string) => process.stdout.write(`${line}\n`)))(
        `[acp ${agentId}] ${arrow} ${stored}`,
      )
    }
  }

  stderr(agentId: AgentId, text: string): void {
    this.buffers(agentId).stderr.push(text)
  }

  stderrText(agentId: AgentId): TextRing {
    return this.buffers(agentId).stderr
  }

  event(agentId: AgentId, event: string, detail?: string): void {
    this.buffers(agentId).events.push({
      at: this.now(),
      event,
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  log(level: LogEntry['level'], message: string): void {
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

  agentRecords(agentId: AgentId): {
    traffic: TrafficRecord[]
    stderr: string
    events: AgentEvent[]
  } {
    const buffers = this.buffers(agentId)
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
