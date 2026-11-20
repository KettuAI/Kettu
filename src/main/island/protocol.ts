// The notch island's protocol: JSON Lines over the helper's standard input and output, main the
// only other end. Main sends the view it built and every word the helper shows; the helper sends
// back only what the user did, which main checks against what it sent before acting on it.

import type { ToolKind } from '@shared/thread'

/** Raised whenever either side's messages change in a way the other must know. */
export const ISLAND_PROTOCOL = 1

/** The longest line either side sends, in bytes of UTF-8, the newline excluded. */
export const MAX_LINE_BYTES = 1024 * 1024

/** The host a row's session runs on; null in a row for this computer. */
export interface IslandHost {
  id: string
  name: string
  offline: boolean
}

export type IslandStatus =
  'running' | 'waiting' | 'unread' | 'failed' | 'idle' | 'limited' | 'starting' | 'sign_in'

/** One session's row, as the island lists it. */
export interface IslandRow {
  /** What the helper names the row by when it is opened. */
  key: string
  sessionId: string
  host: IslandHost | null
  /** The session or the task it belongs to, by title when Kettu knows it. */
  parent: { kind: 'session' | 'task'; title: string | null } | null
  title: string
  project: string
  agent: { id: string; name: string; harness: string; color: string | null }
  model: string | null
  /** `running` turns into stuck once `toolSince` is older than the hello's `stuckAfterMs`. */
  status: IslandStatus
  /** When it entered its status, as far as Kettu knows; null when it does not. */
  since: number | null
  /** What it does or waits for, in one line. */
  line: string
  /** When the tool call it runs started; null while it runs none. */
  toolSince: number | null
  toolKind: ToolKind | null
  turnStartedAt: number | null
  plan: { done: number; total: number; current: string | null } | null
  /** Its sub-agents running, and the line that says so; null for none. */
  subagents: { running: number; text: string } | null
  /** The used-up window that holds it back, and when that resets. */
  limit: { label: string; resetsAt: number | null } | null
}

export type IslandRequestKind = 'permission' | 'question' | 'plan' | 'origin' | 'app' | 'kettu'

export type IslandOptionStyle = 'deny' | 'allow_once' | 'allow_always' | 'normal' | 'recommended'

/** What waits for the user's answer; the kinds the island cannot answer carry no options. */
export interface IslandRequest {
  key: string
  /** The row of its session. */
  row: string
  kind: IslandRequestKind
  title: string
  /** A few lines: the command, the changed files, the question or the plan's start. */
  lines: string[]
  /** Whether `lines` is code, as a command is. */
  code: boolean
  options: { id: string; label: string; style: IslandOptionStyle }[]
  askedAt: number | null
}

export interface IslandSummary {
  running: number
  waiting: number
  failed: number
  /** The tightest plan window of the agents on a plan. */
  limit: {
    agent: string
    label: string
    usedPercent: number | null
    reached: boolean
    resetsAt: number | null
  } | null
}

export interface IslandView {
  rows: IslandRow[]
  requests: IslandRequest[]
  summary: IslandSummary
}

export type ColorMode = 'light' | 'dark'

export type PopKind = 'permission' | 'turn-ended' | 'error' | 'routine-ended' | 'routine-paused'

export type AnswerResult =
  { result: 'answered' } | { result: 'elsewhere' } | { result: 'failed'; message: string }

export type MainToIsland =
  | {
      type: 'hello'
      protocol: number
      version: string
      locale: string
      strings: Record<string, string>
      colorMode: ColorMode
      stuckAfterMs: number
    }
  | ({ type: 'view'; seq: number } & IslandView)
  | {
      type: 'change'
      seq: number
      rows: IslandRow[]
      removedRows: string[]
      /** The rows' keys in the order to show them, when it changed. */
      order?: string[]
      requests: IslandRequest[]
      removedRequests: string[]
      requestOrder?: string[]
      summary?: IslandSummary
    }
  | { type: 'pop'; row: string | null; kind: PopKind; title: string; body: string }
  | ({ type: 'answered'; id: string } & AnswerResult)
  | { type: 'strings'; locale: string; strings: Record<string, string> }
  | { type: 'appearance'; colorMode: ColorMode }
  | { type: 'quit' }

export type IslandToMain =
  /** `shows`: the helper draws the island on screen, so notifications of its kinds stay quiet. */
  | { type: 'ready'; protocol: number; version: string; shows: boolean }
  | { type: 'answer'; id: string; request: string; option: string }
  /** A row's session, or Kettu itself without one. */
  | { type: 'open'; row: string | null }
  | { type: 'expanded' }
  | { type: 'resync' }

const MAX_ID_CHARS = 128
const MAX_VERSION_CHARS = 64

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
}

/**
 * One line from the helper as a message, or null for one main does not take: not JSON, not an
 * object, an unknown type, or a field of the wrong kind or size. Whether a request or a row it
 * names exists is the bridge's to check.
 */
export function parseIslandLine(line: string): IslandToMain | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  switch (message.type) {
    case 'ready': {
      const { protocol, version, shows } = message
      if (typeof protocol !== 'number' || !Number.isSafeInteger(protocol)) return null
      if (typeof version !== 'string' || version.length > MAX_VERSION_CHARS) return null
      if (typeof shows !== 'boolean') return null
      return { type: 'ready', protocol, version, shows }
    }
    case 'answer': {
      const { id, request, option } = message
      if (!isId(id) || !isId(request) || !isId(option)) return null
      return { type: 'answer', id, request, option }
    }
    case 'open': {
      const { row } = message
      if (row !== null && row !== undefined && !isId(row)) return null
      return { type: 'open', row: row ?? null }
    }
    case 'expanded':
      return { type: 'expanded' }
    case 'resync':
      return { type: 'resync' }
    default:
      return null
  }
}

/** A message as the line main writes, newline included; null when it would be too long. */
export function islandLine(message: MainToIsland): string | null {
  const json = JSON.stringify(message)
  // UTF-8 takes at most 3 bytes per UTF-16 unit, so most lines need no exact count.
  if (json.length * 3 > MAX_LINE_BYTES && new TextEncoder().encode(json).length > MAX_LINE_BYTES) {
    return null
  }
  return `${json}\n`
}

/**
 * Splits the helper's output into lines. A line longer than `MAX_LINE_BYTES` is dropped whole,
 * up to its newline, and reported once, so a helper that never ends a line cannot fill memory.
 */
export class LineReader {
  private parts: Uint8Array[] = []
  private size = 0
  private dropping = false
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onBad: (reason: 'too_long' | 'not_utf8') => void,
  ) {}

  push(chunk: Uint8Array): void {
    let start = 0
    for (;;) {
      const end = chunk.indexOf(0x0a, start)
      if (end === -1) {
        this.keep(chunk.subarray(start))
        return
      }
      this.keep(chunk.subarray(start, end))
      this.finish()
      start = end + 1
    }
  }

  private keep(bytes: Uint8Array): void {
    if (this.dropping || bytes.length === 0) return
    this.size += bytes.length
    if (this.size > MAX_LINE_BYTES) {
      this.parts = []
      this.size = 0
      this.dropping = true
      this.onBad('too_long')
      return
    }
    this.parts.push(bytes.slice())
  }

  private finish(): void {
    if (this.dropping) {
      this.dropping = false
      return
    }
    const bytes = new Uint8Array(this.size)
    let at = 0
    for (const part of this.parts) {
      bytes.set(part, at)
      at += part.length
    }
    this.parts = []
    this.size = 0
    let line: string
    try {
      line = this.decoder.decode(bytes)
    } catch {
      this.onBad('not_utf8')
      return
    }
    if (line.trim()) this.onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
  }
}
