// What the Requests pane shows: a session's exchanges with its model, read from the agent's own
// record of the session when the pane opens. Kettu keeps none of it and logs none of it.

/** Where a session's requests are read from. */
export type RequestsSource = 'claude' | 'codex' | 'opencode' | 'cline' | 'antigravity' | 'acp'

/** How many requests a page holds, counted back from where it starts. */
export const REQUESTS_PAGE = 50
/** Strings longer than this are folded in Raw until it is read in full. */
export const RAW_FOLD_CHARS = 4096
/** The key of the object that stands in Raw for a folded string. */
export const RAW_FOLDED = '\u0000folded'

export type RequestActionKind =
  'thinking' | 'read' | 'search' | 'edit' | 'run' | 'web' | 'agent' | 'reply' | 'tool'

/** What a request did, such as one tool it called; repeats of one tool are counted. */
export interface RequestAction {
  kind: RequestActionKind
  label: string
  count: number
}

export interface RequestTokens {
  /** Input not read from the cache. */
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
  /** The part of `cacheWrite` kept for an hour, the rest for five minutes. */
  cacheWrite1h: number | null
  output: number | null
  /** Thinking or reasoning, counted in `output`. */
  reasoning: number | null
}

export type RequestPartKind =
  'prompt' | 'tool-result' | 'attachment' | 'thinking' | 'text' | 'tool-call' | 'other'

/** One thing a request sent or received, shown as a line. */
export interface RequestPart {
  kind: RequestPartKind
  label: string
  preview: string
  /** Its size in UTF-8 bytes, when it has one worth showing. */
  bytes: number | null
  error?: boolean
  /** How many messages the line stands for, where it groups several of one kind. */
  count?: number
}

export interface RequestParam {
  name: string
  value: string
}

export type RequestStatus = 'done' | 'running' | 'failed'

export interface ModelRequest {
  /** The agent's own id for the request, stable within the session. */
  id: string
  turnId: string
  sentAt: number | null
  endedAt: number | null
  model: string | null
  params: RequestParam[]
  requestId: string | null
  stop: string | null
  tokens: RequestTokens
  actions: RequestAction[]
  sent: RequestPart[]
  received: RequestPart[]
  /** Messages carried over from the request before, and added by this one, when recorded. */
  kept: number | null
  added: number | null
  status: RequestStatus
  error: string | null
  /** How many of the agent's records Raw holds for it. */
  records: number
  /** Reads those records with `sessions.modelRequestRaw`. */
  raw: string
}

export interface RequestTurn {
  /** The agent's id for the prompt that started the turn. */
  id: string
  /** Its place in the session, from 1, when the agent records it. */
  index: number | null
  /** The start of the user's message, empty when the page does not reach it. */
  prompt: string
  startedAt: number | null
  requests: ModelRequest[]
}

export interface RequestsSystemBlock {
  preview: string
  chars: number
}

export interface RequestsToolGroup {
  /** The agent's own tools, an MCP server's, or another of the agent's groups. */
  kind: 'builtin' | 'mcp' | 'other'
  name: string
  tools: string[]
}

export interface RequestsToolChange {
  at: number | null
  added: string[]
  removed: string[]
}

/** What every request starts with: the system prompt and the tools, or the agent's instructions. */
export interface RequestsSystem {
  kind: 'system' | 'instructions'
  blocks: RequestsSystemBlock[]
  groups: RequestsToolGroup[]
  toolCount: number | null
  changes: RequestsToolChange[]
}

export interface ModelRequestsPage {
  source: RequestsSource
  /** Oldest first; the first may continue a turn the next older page starts. */
  turns: RequestTurn[]
  /** Reads the turns before these; null at the start of the session. */
  before: string | null
}

/** What the whole session file holds beyond its pages. */
export interface ModelRequestsOverview {
  source: RequestsSource
  requests: number | null
  /** The agent's own reckoning at API prices, which a subscription is not charged. */
  costUsd: number | null
  /** Every request's tokens added up, as the record holds them. */
  tokens: RequestTokens | null
  system: RequestsSystem | null
  /** Each turn's place in the session by its id, for an agent whose pages do not say. */
  turns: Record<string, number> | null
}

/** The agent's records for one request, or for the system prompt and tools. */
export interface ModelRequestRaw {
  records: unknown[]
  /** Whether long strings were folded; reading again with `full` returns them whole. */
  folded: boolean
}

/** The main thread's latest request as the stream reported it, kept only while the session is open. */
export interface LastRequest {
  /** When it went out. */
  at: number
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
  /** Null while it runs. */
  output: number | null
  ms: number | null
}

/** The share of all input that was read from the cache. */
export function cacheHitShare(tokens: RequestTokens): number | null {
  if (tokens.cacheRead === null) return null
  const all = (tokens.input ?? 0) + tokens.cacheRead + (tokens.cacheWrite ?? 0)
  return all > 0 ? tokens.cacheRead / all : null
}

/** All input of a request, read from the cache or not. */
export function inputTotal(tokens: RequestTokens): number | null {
  if (tokens.input === null && tokens.cacheRead === null && tokens.cacheWrite === null) return null
  return (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0)
}

/** A copy of a record with every string over `limit` characters replaced by a folded stand-in. */
export function foldLongStrings(
  value: unknown,
  limit = RAW_FOLD_CHARS,
): { value: unknown; folded: boolean } {
  let folded = false
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v.length <= limit) return v
      folded = true
      return { [RAW_FOLDED]: utf8Length(v) }
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, item] of Object.entries(v)) out[k] = walk(item)
      return out
    }
    return v
  }
  return { value: walk(value), folded }
}

/** The size in bytes a folded stand-in replaces, or null when the value is not one. */
export function foldedBytes(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== RAW_FOLDED) return null
  const bytes = (value as Record<string, unknown>)[RAW_FOLDED]
  return typeof bytes === 'number' ? bytes : null
}

export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}
