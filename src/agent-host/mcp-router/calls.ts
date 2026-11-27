// The record of tool calls through the router: one line of metadata per call, in a file per day
// under the host's state, kept for 30 days. A call's arguments and what it returned are never
// kept; the session's own record has them, and a second copy would only be one more to leak.

import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { isAgentId } from '@shared/agents'
import {
  MCP_CALL_DAYS,
  MCP_CALL_ERROR_CHARS,
  MCP_CALLS_PAGE,
  type McpCallQuery,
  type McpCallRecord,
  type McpCallResult,
} from '@shared/mcp-insight'
import { terminalApp, type McpTerminalApp } from '@shared/mcp-terminal'
import { notifyStorageWrite, type LogFn } from '../storage'

const DAY_MS = 24 * 60 * 60 * 1000
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const RESULTS: readonly McpCallResult[] = ['ok', 'tool-error', 'error', 'refused', 'cancelled']
/** A line longer than this is not one Kettu wrote. */
const MAX_LINE = 8192
const MAX_FOLDER = 1024

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only the fields a record has: whatever else a caller passes is dropped, never written. */
export function callLine(record: McpCallRecord): string {
  const kept: McpCallRecord = {
    at: record.at,
    serverId: record.serverId,
    sessionId: record.sessionId,
    agentId: record.agentId,
    tool: record.tool.slice(0, 128),
    ms: Math.max(0, Math.round(record.ms)),
    bytes: Math.max(0, Math.round(record.bytes)),
    result: record.result,
    ...(record.error !== undefined && record.result !== 'ok'
      ? { error: record.error.replace(/\s+/g, ' ').slice(0, MCP_CALL_ERROR_CHARS) }
      : {}),
    ...(record.sessionId === null && record.folder !== undefined
      ? { folder: record.folder.slice(0, MAX_FOLDER) }
      : {}),
    ...(record.sessionId === null && record.app !== undefined ? { app: record.app } : {}),
  }
  return `${JSON.stringify(kept)}\n`
}

function readLine(line: string): McpCallRecord | null {
  if (line.length === 0 || line.length > MAX_LINE) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const { at, serverId, sessionId, agentId, tool, ms, bytes, result, error, folder, app } = raw
  if (typeof at !== 'number' || typeof serverId !== 'string' || typeof tool !== 'string') {
    return null
  }
  if (sessionId !== null && typeof sessionId !== 'string') return null
  if (agentId !== null && !isAgentId(agentId)) return null
  if (typeof ms !== 'number' || typeof bytes !== 'number') return null
  if (!RESULTS.includes(result as McpCallResult)) return null
  return {
    at,
    serverId,
    sessionId,
    agentId,
    tool,
    ms,
    bytes,
    result: result as McpCallResult,
    ...(typeof error === 'string' ? { error } : {}),
    ...(typeof folder === 'string' && sessionId === null ? { folder } : {}),
    ...(typeof app === 'string' && sessionId === null && terminalApp(`app:${app}`) === app
      ? { app: app as McpTerminalApp }
      : {}),
  }
}

export class McpCalls {
  private writing: Promise<void> = Promise.resolve()
  private pruned: string | null = null

  constructor(
    private readonly dir: string | null,
    private readonly log: LogFn,
    private readonly now: () => number = Date.now,
  ) {}

  /** Appends a call, in order with the others; a failed write is logged, never thrown. */
  add(record: McpCallRecord): Promise<void> {
    const dir = this.dir
    if (!dir) return Promise.resolve()
    this.writing = this.writing.then(async () => {
      const file = path.join(dir, `${dayOf(record.at)}.jsonl`)
      try {
        await mkdir(dir, { recursive: true })
        await this.prune()
        await appendFile(file, callLine(record), {
          mode: 0o600,
        })
        notifyStorageWrite(file, true)
      } catch (error) {
        notifyStorageWrite(file, false, error)
        this.log('warn', `Could not record an MCP call: ${(error as Error).message}`)
      }
    })
    return this.writing
  }

  /** Removes the days older than what is kept, once a day. */
  async prune(): Promise<void> {
    const dir = this.dir
    if (!dir) return
    const today = dayOf(this.now())
    if (this.pruned === today) return
    this.pruned = today
    const oldest = dayOf(this.now() - MCP_CALL_DAYS * DAY_MS)
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      const day = FILE.exec(name)?.[1]
      if (day !== undefined && day < oldest) await rm(path.join(dir, name), { force: true })
    }
  }

  /** A server's calls, newest first, as `query` picks them, within the days kept. */
  async list(query: McpCallQuery): Promise<McpCallRecord[]> {
    const dir = this.dir
    if (!dir) return []
    await this.writing
    const limit = Math.min(query.limit ?? MCP_CALLS_PAGE, MCP_CALLS_PAGE)
    const kept = this.now() - MCP_CALL_DAYS * DAY_MS
    const since = Math.max(query.since ?? 0, kept)
    const needle = query.query?.trim().toLowerCase() ?? ''
    const days = (await readdir(dir).catch(() => [] as string[]))
      .map((name) => FILE.exec(name)?.[1])
      .filter((day): day is string => day !== undefined && day >= dayOf(since))
      .sort()
      .reverse()
    const out: McpCallRecord[] = []
    for (const day of days) {
      const text = await readFile(path.join(dir, `${day}.jsonl`), 'utf8').catch(() => '')
      const records = text
        .split('\n')
        .map(readLine)
        .filter((record): record is McpCallRecord => record !== null)
        .filter(
          (record) =>
            record.serverId === query.serverId &&
            record.at >= since &&
            (query.before === undefined || record.at < query.before) &&
            (!query.failed || record.result !== 'ok') &&
            (needle === '' || record.tool.toLowerCase().includes(needle)),
        )
      out.push(...records.reverse())
      if (out.length >= limit) break
    }
    return out.sort((a, b) => b.at - a.at).slice(0, limit)
  }
}
