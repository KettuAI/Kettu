// Reads a Claude Code session file into requests: each `api-request` record with the lines sent
// before it, the response lines that name it through `requestRef`, and the errors that follow it.
// Files written before Claude Code 2.1.323 have no `api-request` records; there each response
// message is a request of its own, with no parameters.

import type {
  RequestAction,
  RequestActionKind,
  RequestParam,
  RequestPart,
  RequestTokens,
  RequestTurn,
  RequestsSystem,
  RequestsToolGroup,
  ModelRequest,
} from '@shared/model-requests'
import { utf8Length } from '@shared/model-requests'

/** One line of the file, with where it lies so Raw can read it again. */
export interface TranscriptLine {
  start: number
  end: number
  record: Record<string, unknown>
}

export interface ParsedRequest {
  request: ModelRequest
  /** The byte ranges of the request's own lines, in file order. */
  ranges: [number, number][]
}

export interface ParsedTranscript {
  turns: RequestTurn[]
  requests: Map<string, ParsedRequest>
}

const PREVIEW_CHARS = 200

type Rec = Record<string, unknown>

export const obj = (v: unknown): Rec | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const time = (v: unknown): number | null => {
  const s = str(v)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

export function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line
}

/** A prompt's first words; one Kettu or Claude Code wrote in tags, such as a task notification, by its summary. */
export function promptPreview(text: string): string {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]
  return preview((summary ?? text).replace(/<[^>]+>/g, ' '))
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content)
    .map((block) => {
      const b = obj(block)
      if (!b) return ''
      if (typeof b.text === 'string') return b.text
      if (b.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join(' ')
}

/** A user line that starts a turn: the user's own message, not a tool result or a reminder. */
export function isPrompt(record: Rec): boolean {
  if (record.type !== 'user' || record.isMeta === true || record.isCompactSummary === true)
    return false
  if (record.toolUseResult !== undefined) return false
  const content = obj(record.message)?.content
  if (typeof content === 'string') return true
  const blocks = arr(content)
  return blocks.length > 0 && blocks.every((b) => obj(b)?.type !== 'tool_result')
}

function sentParts(record: Rec): RequestPart[] {
  if (record.type === 'attachment') {
    const attachment = obj(record.attachment)
    const rendered = arr(record.rendered)
      .map((r) => str(obj(r)?.content) ?? '')
      .join('\n')
    const kind = str(attachment?.type) ?? 'attachment'
    return [
      {
        kind: 'attachment',
        label: kind,
        preview: preview(rendered),
        bytes: rendered ? utf8Length(rendered) : null,
      },
    ]
  }
  if (record.type !== 'user') return []
  const content = obj(record.message)?.content
  if (isPrompt(record)) {
    const text = textOf(content)
    return [{ kind: 'prompt', label: 'prompt', preview: preview(text), bytes: utf8Length(text) }]
  }
  const parts: RequestPart[] = []
  for (const block of typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : arr(content)) {
    const b = obj(block)
    if (!b) continue
    if (b.type === 'tool_result') {
      const text = textOf(b.content)
      parts.push({
        kind: 'tool-result',
        label: 'tool_result',
        preview: preview(text),
        bytes: utf8Length(text),
        error: b.is_error === true || undefined,
      })
    } else {
      const text = textOf([b])
      parts.push({
        kind: 'other',
        label: record.isCompactSummary === true ? 'summary' : 'message',
        preview: preview(text),
        bytes: utf8Length(text),
      })
    }
  }
  return parts
}

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** What a tool call did, named for a row: its kind and a few words of its input. */
export function toolAction(
  name: string,
  input: Rec | null,
): { kind: RequestActionKind; label: string } {
  const file = str(input?.file_path) ?? str(input?.notebook_path) ?? str(input?.path)
  switch (name) {
    case 'Read':
      return { kind: 'read', label: file ? `Read ${basename(file)}` : 'Read' }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'edit', label: file ? `${name} ${basename(file)}` : name }
    case 'Bash': {
      const command = str(input?.command)
      return { kind: 'run', label: command ? `Bash ${preview(command).slice(0, 60)}` : 'Bash' }
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(input?.pattern)
      return { kind: 'search', label: pattern ? `${name} ${pattern.slice(0, 60)}` : name }
    }
    case 'WebFetch':
    case 'WebSearch':
      return { kind: 'web', label: name }
    case 'Agent':
    case 'Task': {
      const what = str(input?.subagent_type) ?? str(input?.description)
      return { kind: 'agent', label: what ? `Agent ${what}` : 'Agent' }
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return { kind: 'tool', label: mcp ? `${mcp[2]}` : name }
}

/** A row's summary of what came back: tool calls by kind, thinking first and the reply last. */
export function summarizeActions(
  received: { kind: RequestActionKind; label: string; tool?: string }[],
): RequestAction[] {
  const out: RequestAction[] = []
  const byKey = new Map<string, RequestAction & { tool?: string }>()
  for (const item of received) {
    const key = item.tool ?? item.kind
    const seen = byKey.get(key)
    if (seen) {
      seen.count += 1
      if (item.tool) seen.label = item.tool
      continue
    }
    const action = { kind: item.kind, label: item.label, count: 1, tool: item.tool }
    byKey.set(key, action)
    out.push(action)
  }
  const rank = (k: RequestActionKind): number => (k === 'thinking' ? 0 : k === 'reply' ? 2 : 1)
  return out
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map(({ kind, label, count }) => ({ kind, label, count }))
}

export function emptyTokens(): RequestTokens {
  return {
    input: null,
    cacheRead: null,
    cacheWrite: null,
    cacheWrite1h: null,
    output: null,
    reasoning: null,
  }
}

export function claudeTokens(usage: Rec | null): RequestTokens {
  if (!usage) return emptyTokens()
  const creation = obj(usage.cache_creation)
  const details = obj(usage.output_tokens_details)
  return {
    input: num(usage.input_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    cacheWrite1h: num(creation?.ephemeral_1h_input_tokens),
    output: num(usage.output_tokens),
    reasoning: num(details?.thinking_tokens),
  }
}

function requestParams(record: Rec): RequestParam[] {
  const params = obj(record.params)
  if (!params) return []
  const out: RequestParam[] = []
  const effort = str(obj(params.output_config)?.effort)
  if (effort) out.push({ name: 'effort', value: effort })
  const thinking = obj(params.thinking)
  const thinkingType = str(thinking?.type)
  if (thinkingType) {
    const budget = num(thinking?.budget_tokens)
    out.push({ name: 'thinking', value: budget ? `${thinkingType} ${budget}` : thinkingType })
  }
  const max = num(params.max_tokens)
  if (max !== null) out.push({ name: 'max_tokens', value: max.toLocaleString('en-US') })
  const ttls = new Set(
    arr(record.cacheControl)
      .map((c) => str(obj(obj(c)?.value)?.ttl))
      .filter((t): t is string => !!t),
  )
  if (ttls.size) out.push({ name: 'cache', value: [...ttls].join(', ') })
  return out
}

interface Building extends ParsedRequest {
  pending: boolean
  received: { kind: RequestActionKind; label: string; tool?: string }[]
  messageIds: Set<string>
}

function newRequest(id: string, turnId: string, sentAt: number | null): Building {
  return {
    request: {
      id,
      turnId,
      sentAt,
      endedAt: null,
      model: null,
      params: [],
      requestId: null,
      stop: null,
      tokens: emptyTokens(),
      actions: [],
      sent: [],
      received: [],
      kept: null,
      added: null,
      status: 'running',
      error: null,
      records: 0,
      raw: '',
    },
    ranges: [],
    pending: true,
    received: [],
    messageIds: new Set(),
  }
}

function apiError(record: Rec): string {
  const error = obj(record.error)
  const status = num(error?.status)
  const message = str(error?.message) ?? 'API error'
  const attempt = num(record.retryAttempt)
  const max = num(record.maxRetries)
  const head = status ? `${status} ${message}` : message
  return attempt !== null && max !== null ? `${head} · retry ${attempt}/${max}` : head
}

/**
 * The requests in some lines of a session file, oldest first. `lines` is a run of whole lines in
 * file order, such as one page read back from the end; the first turn may begin before it.
 */
export function parseClaudeTranscript(lines: TranscriptLine[]): ParsedTranscript {
  const turns: RequestTurn[] = []
  const requests = new Map<string, ParsedRequest>()
  const turnById = new Map<string, RequestTurn>()
  let turn: RequestTurn | null = null
  let sent: { parts: RequestPart[]; range: [number, number] }[] = []
  let last: Building | null = null
  const building = new Map<string, Building>()
  const byMessage = new Map<string, Building>()

  const ensureTurn = (id: string): RequestTurn => {
    const known = turnById.get(id)
    if (known) return known
    const created: RequestTurn = { id, index: null, prompt: '', startedAt: null, requests: [] }
    turnById.set(id, created)
    turns.push(created)
    return created
  }

  const take = (b: Building): void => {
    for (const s of sent) {
      b.request.sent.push(...s.parts)
      b.ranges.push(s.range)
    }
    sent = []
  }

  const open = (id: string, sentAt: number | null): Building => {
    const t = turn ?? ensureTurn(`before:${id}`)
    turn = t
    const b = newRequest(id, t.id, sentAt)
    take(b)
    building.set(id, b)
    requests.set(id, b)
    t.requests.push(b.request)
    last = b
    return b
  }

  for (const line of lines) {
    const r = line.record
    const range: [number, number] = [line.start, line.end]
    const type = r.type
    if (type === 'user' || type === 'attachment') {
      if (type === 'user' && isPrompt(r)) {
        const id = str(r.promptId) ?? str(r.uuid) ?? `prompt:${line.start}`
        turn = ensureTurn(id)
        turn.index = num(obj(r.turnPosition)?.turnIndex)
        turn.prompt = promptPreview(textOf(obj(r.message)?.content))
        turn.startedAt = time(r.timestamp)
      } else if (type === 'user' && !turn) {
        const promptId = str(r.promptId)
        if (promptId) turn = ensureTurn(promptId)
      }
      sent.push({ parts: sentParts(r), range })
      continue
    }
    if (type === 'api-request') {
      const id = str(r.id)
      if (!id) continue
      const b = open(id, time(r.timestamp))
      b.ranges.push(range)
      const params = obj(r.params)
      b.request.model = str(params?.model)
      b.request.params = requestParams(r)
      const keep = num(r.keep)
      b.request.kept = keep
      b.request.added = arr(r.tail).length || null
      continue
    }
    if (type === 'assistant') {
      const message = obj(r.message)
      if (!message) continue
      const ref = str(r.requestRef)
      const messageId = str(message.id) ?? `line:${line.start}`
      let b: Building | null | undefined = ref ? building.get(ref) : undefined
      if (!b && !ref && str(message.model) === '<synthetic>') b = last
      if (!b) {
        // Files without request records: one request per response message.
        b = byMessage.get(messageId) ?? open(messageId, null)
      }
      b.messageIds.add(messageId)
      byMessage.set(messageId, b)
      b.ranges.push(range)
      const model = str(message.model)
      if (model === '<synthetic>') {
        b.request.status = 'failed'
        b.request.error = b.request.error ?? preview(textOf(message.content))
      } else {
        if (model) b.request.model = model
        b.request.status = 'done'
        b.request.error = null
      }
      const usage = obj(message.usage)
      if (usage && model !== '<synthetic>') b.request.tokens = claudeTokens(usage)
      b.request.stop = str(message.stop_reason) ?? b.request.stop
      b.request.requestId = str(r.requestId) ?? b.request.requestId
      b.request.endedAt = time(r.timestamp) ?? b.request.endedAt
      for (const block of arr(message.content)) {
        const c = obj(block)
        if (!c) continue
        if (c.type === 'thinking' || c.type === 'redacted_thinking') {
          const text = str(c.thinking) ?? ''
          b.request.received.push({
            kind: 'thinking',
            label: 'thinking',
            preview: preview(text),
            bytes: text ? utf8Length(text) : null,
          })
          b.received.push({ kind: 'thinking', label: 'Thinking' })
        } else if (c.type === 'text') {
          const text = str(c.text) ?? ''
          if (model === '<synthetic>') continue
          b.request.received.push({
            kind: 'text',
            label: 'text',
            preview: preview(text),
            bytes: utf8Length(text),
          })
          b.received.push({ kind: 'reply', label: 'Reply' })
        } else if (c.type === 'tool_use' || c.type === 'server_tool_use') {
          const name = str(c.name) ?? 'tool'
          const input = obj(c.input)
          const action = toolAction(name, input)
          const json = input ? JSON.stringify(input) : ''
          const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
          b.request.received.push({
            kind: 'tool-call',
            // An MCP tool is named by its server, with the tool in the line.
            label: mcp ? mcp[1] : name,
            preview: preview(action.label),
            bytes: utf8Length(json),
          })
          b.received.push({ ...action, tool: name })
        }
      }
      b.request.actions = summarizeActions(b.received)
      last = b
      continue
    }
    if (type === 'system') {
      if (r.subtype === 'api_error' && last) {
        last.ranges.push(range)
        last.request.error = apiError(r)
        if (last.request.status !== 'done') last.request.status = 'failed'
      }
      continue
    }
  }

  for (const b of building.values()) {
    b.ranges.sort((a, z) => a[0] - z[0])
    b.request.records = b.ranges.length
    b.request.raw = encodeRanges(b.ranges)
  }
  return { turns, requests }
}

/** The system prompt and tools from the `api-request-shape` records, oldest first. */
export function summarizeShapes(
  shapes: { at: number | null; shape: Rec }[],
): RequestsSystem | null {
  const latest = shapes.at(-1)
  if (!latest) return null
  const toolNames = (shape: Rec): string[] =>
    arr(shape.tools)
      .map((t) => str(obj(t)?.name))
      .filter((n): n is string => !!n)
  const groups = new Map<string, string[]>()
  for (const name of toolNames(latest.shape)) {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
    const group = mcp ? mcp[1] : 'builtin'
    const list = groups.get(group) ?? []
    list.push(mcp ? mcp[2] : name)
    groups.set(group, list)
  }
  const toolGroups: RequestsToolGroup[] = [...groups].map(([name, tools]) => ({
    kind: name === 'builtin' ? 'builtin' : 'mcp',
    name,
    tools,
  }))
  toolGroups.sort((a, b) =>
    a.name === 'builtin' ? -1 : b.name === 'builtin' ? 1 : a.name.localeCompare(b.name),
  )
  const changes = []
  for (let i = 1; i < shapes.length; i++) {
    const before = new Set(toolNames(shapes[i - 1].shape))
    const after = new Set(toolNames(shapes[i].shape))
    const added = [...after].filter((n) => !before.has(n))
    const removed = [...before].filter((n) => !after.has(n))
    if (added.length || removed.length) changes.push({ at: shapes[i].at, added, removed })
  }
  return {
    kind: 'system',
    blocks: arr(latest.shape.system).map((block) => {
      const text = str(obj(block)?.text) ?? ''
      return { preview: preview(text), chars: text.length }
    }),
    groups: toolGroups,
    toolCount: toolNames(latest.shape).length,
    changes,
  }
}

export function shapeTime(record: Rec): number | null {
  return time(record.timestamp)
}

/** Byte ranges as the opaque `raw` handle of a request. */
export function encodeRanges(ranges: [number, number][]): string {
  return ranges.map(([start, end]) => `${start}-${end}`).join(',')
}

/** The ranges of a `raw` handle, or null when it is not one. */
export function decodeRanges(raw: string): [number, number][] | null {
  if (!/^\d+-\d+(,\d+-\d+)*$/.test(raw)) return null
  const ranges = raw.split(',').map((part) => part.split('-').map(Number) as [number, number])
  return ranges.every(
    ([start, end]) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < end,
  )
    ? ranges
    : null
}
