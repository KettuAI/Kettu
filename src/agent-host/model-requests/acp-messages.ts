// The JSON-RPC messages Kettu exchanged with each ACP session since the host started, for the
// Requests pane. ACP reports turns rather than the agent's requests to its model, and no record
// of the session outside the agent, so these stay in memory, bounded, and are never written out.

import {
  foldLongStrings,
  utf8Length,
  type ModelRequest,
  type RequestAction,
  type RequestActionKind,
  type RequestPart,
  type RequestTokens,
  type RequestTurn,
} from '@shared/model-requests'
import type { AgentId } from '@shared/thread'
import { cachedInInput } from '../acp/mapper'
import { t } from '../i18n'
import { arr, emptyTokens, num, obj, preview, str, summarizeActions } from './claude-transcript'
import { foldAll, type ModelRequestsReader } from './reader'

/** What one session keeps, oldest dropped first. */
export const SESSION_MESSAGES = 2_000
export const SESSION_BYTES = 8 << 20
/** How many sessions keep messages, the least recently active dropped first. */
export const SESSIONS = 50
/** A message longer than this is kept with its long strings folded. */
const MESSAGE_CHARS = 256 * 1024

type Rec = Record<string, unknown>

export interface StoredMessage {
  seq: number
  at: number
  direction: 'in' | 'out'
  method: string | null
  /** The message as JSON text. */
  text: string
}

interface SessionLog {
  messages: StoredMessage[]
  bytes: number
}

export class AcpMessages {
  private readonly sessions = new Map<string, SessionLog>()
  // A request's session by its id, until its response arrives from the other side.
  private readonly pending = new Map<string, string>()
  private seq = 0

  constructor(private readonly now: () => number = Date.now) {}

  add(agentId: AgentId, direction: 'in' | 'out', message: unknown): void {
    const m = obj(message)
    if (!m) return
    const method = str(m.method)
    const id = m.id === undefined || m.id === null ? null : String(m.id)
    let sessionId = str(obj(m.params)?.sessionId)
    if (!method && id !== null) {
      // A response answers a request that went the other way.
      const key = `${agentId}\n${direction === 'in' ? 'out' : 'in'}\n${id}`
      sessionId = this.pending.get(key) ?? str(obj(m.result)?.sessionId)
      this.pending.delete(key)
    } else if (method && id !== null && sessionId) {
      this.pending.set(`${agentId}\n${direction}\n${id}`, sessionId)
      if (this.pending.size > 10_000) this.pending.delete(this.pending.keys().next().value!)
    }
    if (!sessionId) return
    let text = JSON.stringify(m)
    if (text.length > MESSAGE_CHARS) text = JSON.stringify(foldLongStrings(m).value)
    const key = `${agentId}\n${sessionId}`
    const log = this.sessions.get(key) ?? { messages: [], bytes: 0 }
    this.sessions.delete(key)
    this.sessions.set(key, log)
    log.messages.push({ seq: ++this.seq, at: this.now(), direction, method, text })
    log.bytes += text.length
    while (
      log.messages.length > SESSION_MESSAGES ||
      (log.bytes > SESSION_BYTES && log.messages.length > 1)
    ) {
      log.bytes -= log.messages.shift()!.text.length
    }
    while (this.sessions.size > SESSIONS) this.sessions.delete(this.sessions.keys().next().value!)
  }

  of(agentId: AgentId, sessionId: string): readonly StoredMessage[] {
    return this.sessions.get(`${agentId}\n${sessionId}`)?.messages ?? []
  }
}

const TOOL_KINDS: Record<string, RequestActionKind> = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'search',
  execute: 'run',
  think: 'thinking',
  fetch: 'web',
}

/** ACP's draft usage on a prompt's result, when the agent reports it. */
function acpTokens(usage: Rec | null): RequestTokens {
  if (!usage) return emptyTokens()
  const input = num(usage.inputTokens)
  const cacheRead = num(usage.cachedReadTokens)
  const cacheWrite = num(usage.cachedWriteTokens)
  const output = num(usage.outputTokens)
  const reasoning = num(usage.thoughtTokens)
  const held =
    input === null || output === null
      ? 0
      : cachedInInput({
          total: num(usage.totalTokens),
          input,
          output,
          thought: reasoning,
          cacheRead,
          cacheWrite,
        })
  return {
    input: input === null ? null : input - held,
    cacheRead,
    cacheWrite,
    cacheWrite1h: null,
    output,
    reasoning,
  }
}

function addTokens(sum: RequestTokens | null, t: RequestTokens): RequestTokens | null {
  if (t.input === null && t.output === null) return sum
  const add = (a: number | null, b: number | null) =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0)
  const base = sum ?? emptyTokens()
  return {
    input: add(base.input, t.input),
    cacheRead: add(base.cacheRead, t.cacheRead),
    cacheWrite: add(base.cacheWrite, t.cacheWrite),
    cacheWrite1h: null,
    output: add(base.output, t.output),
    reasoning: add(base.reasoning, t.reasoning),
  }
}

const textOf = (content: unknown): string =>
  arr(content)
    .map((block) => str(obj(block)?.text) ?? '')
    .join(' ')

/** The user's own words of a prompt, without what Kettu adds ahead of them in its own tags. */
export function withoutKettu(text: string): string {
  return text.replace(/<(kettu-[\w-]+)>[\s\S]*?<\/\1>/g, ' ').trim()
}

interface Group {
  part: RequestPart & { count: number }
  text: string
}

/** The messages of one side of a turn, one line per kind, with how many there were. */
function grouped(messages: StoredMessage[]): RequestPart[] {
  const groups = new Map<string, Group>()
  for (const message of messages) {
    let m: Rec
    try {
      m = JSON.parse(message.text) as Rec
    } catch {
      continue
    }
    const params = obj(m.params)
    const update = obj(params?.update)
    const kind = str(update?.sessionUpdate) ?? message.method ?? (m.error ? 'error' : 'result')
    let text = ''
    if (kind === 'session/prompt') text = textOf(params?.prompt)
    else if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk')
      text = str(obj(update?.content)?.text) ?? ''
    else if (kind === 'tool_call') text = str(update?.title) ?? ''
    else if (kind === 'result') text = str(obj(m.result)?.stopReason) ?? ''
    else if (kind === 'error') text = str(obj(m.error)?.message) ?? ''
    const group = groups.get(kind) ?? {
      part: { kind: 'other', label: kind, preview: '', bytes: 0, count: 0 },
      text: '',
    }
    group.part.count += 1
    group.part.bytes = (group.part.bytes ?? 0) + utf8Length(message.text)
    // Streamed chunks join into one text; titles and the rest are listed.
    const joined = kind.endsWith('_chunk') ? '' : group.text && text ? ' · ' : ''
    if (group.text.length < 400) group.text += joined + text
    group.part.preview = preview(group.text)
    if (kind === 'error') group.part.error = true
    groups.set(kind, group)
  }
  return [...groups.values()].map((g) => g.part)
}

/** A session's turns: each `session/prompt` Kettu sent, up to the agent's answer to it. */
export function acpTurns(messages: readonly StoredMessage[]): RequestTurn[] {
  const turns: RequestTurn[] = []
  let current: { turn: RequestTurn; rpcId: string | null; messages: StoredMessage[] } | null = null
  const finish = (end: StoredMessage | null) => {
    if (!current) return
    const { turn, messages: own } = current
    const sent = own.filter((m) => m.direction === 'out')
    const received = own.filter((m) => m.direction === 'in')
    const seen: { kind: RequestActionKind; label: string; tool?: string }[] = []
    let result: Rec | null = null
    let failed: string | null = null
    // The tokens of each model call, for an agent that reports them on a chunk of its own.
    let chunked: RequestTokens | null = null
    for (const message of received) {
      let m: Rec
      try {
        m = JSON.parse(message.text) as Rec
      } catch {
        continue
      }
      const update = obj(obj(m.params)?.update)
      const kind = str(update?.sessionUpdate)
      if (kind === 'tool_call') {
        const toolKind = str(update?.kind) ?? 'other'
        seen.push({
          kind: TOOL_KINDS[toolKind] ?? 'tool',
          label: str(update?.title) ?? toolKind,
          tool: str(update?.title) ?? toolKind,
        })
      } else if (kind === 'agent_thought_chunk' && !seen.some((s) => s.kind === 'thinking')) {
        seen.push({ kind: 'thinking', label: 'Thinking' })
      } else if (kind === 'agent_message_chunk' && !seen.some((s) => s.kind === 'reply')) {
        seen.push({ kind: 'reply', label: 'Reply' })
      }
      const usage = kind === 'agent_message_chunk' ? obj(obj(update?._meta)?.usage) : null
      if (usage) chunked = addTokens(chunked, acpTokens(usage))
      if (message === end) {
        result = obj(m.result)
        failed = str(obj(m.error)?.message)
      }
    }
    const actions: RequestAction[] = summarizeActions(seen)
    const first = own[0]!
    const last = own.at(-1)!
    const stop = str(result?.stopReason)
    const request: ModelRequest = {
      id: turn.id,
      turnId: turn.id,
      sentAt: turn.startedAt,
      endedAt: end ? end.at : null,
      model: null,
      params: [],
      requestId: null,
      stop,
      tokens: obj(result?.usage) ? acpTokens(obj(result?.usage)) : (chunked ?? emptyTokens()),
      actions,
      sent: grouped(sent),
      received: grouped(received),
      kept: null,
      added: null,
      status: failed ? 'failed' : end ? 'done' : 'running',
      error: failed,
      records: own.length,
      raw: `${first.seq}-${last.seq + 1}`,
    }
    turn.requests.push(request)
    turns.push(turn)
    current = null
  }
  for (const message of messages) {
    if (message.direction === 'out' && message.method === 'session/prompt') {
      finish(null)
      let m: Rec = {}
      try {
        m = JSON.parse(message.text) as Rec
      } catch {
        // Kept as it was written.
      }
      current = {
        turn: {
          id: `turn-${message.seq}`,
          index: null,
          prompt: preview(withoutKettu(textOf(obj(m.params)?.prompt))),
          startedAt: message.at,
          requests: [],
        },
        rpcId: m.id === undefined || m.id === null ? null : String(m.id),
        messages: [message],
      }
      continue
    }
    if (!current) continue
    current.messages.push(message)
    if (message.direction === 'in' && !message.method) {
      try {
        const m = JSON.parse(message.text) as Rec
        if (current.rpcId !== null && String(m.id) === current.rpcId) finish(message)
      } catch {
        // Not the answer.
      }
    }
  }
  finish(null)
  return turns
}

/** The Requests pane's reading of ACP sessions, from the messages kept in memory. */
export function acpModelRequests(store: AcpMessages): ModelRequestsReader {
  return {
    async page(target) {
      return {
        source: 'acp',
        turns: acpTurns(store.of(target.agentId, target.acpSessionId)),
        before: null,
      }
    },
    async summary(target) {
      const turns = acpTurns(store.of(target.agentId, target.acpSessionId))
      const tokens = turns
        .map((t) => t.requests[0]!.tokens)
        .reduce<RequestTokens | null>(addTokens, null)
      return {
        source: 'acp',
        requests: turns.length,
        costUsd: null,
        tokens,
        system: null,
        turns: null,
      }
    },
    async raw(target, raw, full) {
      const match = /^(\d+)-(\d+)$/.exec(raw)
      if (!match) throw new Error('Not a turn of this session')
      const [from, to] = [Number(match[1]), Number(match[2])]
      const messages = store
        .of(target.agentId, target.acpSessionId)
        .filter((m) => m.seq >= from && m.seq < to)
      if (messages.length === 0) throw new Error(t('modelRequest.messagesGone'))
      return foldAll(
        messages.map((m) => JSON.parse(m.text) as unknown),
        full,
      )
    },
  }
}
