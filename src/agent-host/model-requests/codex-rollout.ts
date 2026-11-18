// Reads a Codex rollout into requests. A request's outputs (reasoning, messages and tool calls)
// end with a `token_usage_record`, which carries that request's own tokens; what the model was
// sent since the request before (the user's message, tool outputs) comes ahead of them. Rollouts
// written before that record existed end each request with a `token_count` event instead.

import type {
  RequestActionKind,
  RequestParam,
  RequestPart,
  RequestTokens,
  RequestTurn,
  RequestsSystem,
  RequestsToolGroup,
} from '@shared/model-requests'
import { utf8Length } from '@shared/model-requests'
import {
  arr,
  emptyTokens,
  encodeRanges,
  num,
  obj,
  preview,
  str,
  summarizeActions,
  time,
  type ParsedRequest,
  type ParsedTranscript,
  type TranscriptLine,
} from './claude-transcript'

type Rec = Record<string, unknown>

/** Codex counts the cached and cache-written input in its input. */
export function codexTokens(usage: Rec | null): RequestTokens {
  if (!usage) return emptyTokens()
  const input = num(usage.input_tokens)
  const cached = num(usage.cached_input_tokens)
  const written = num(usage.cache_write_input_tokens)
  return {
    input: input === null ? null : Math.max(0, input - (cached ?? 0) - (written ?? 0)),
    cacheRead: cached,
    cacheWrite: written,
    cacheWrite1h: null,
    output: num(usage.output_tokens),
    reasoning: num(usage.reasoning_output_tokens),
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content)
    .map((part) => str(obj(part)?.text) ?? '')
    .filter(Boolean)
    .join(' ')
}

/** A call's input, which Codex writes as a JSON string or as the tool's own text. */
function callInput(payload: Rec): { text: string; json: Rec | null } {
  const raw = str(payload.arguments) ?? str(payload.input) ?? ''
  try {
    const parsed = JSON.parse(raw) as unknown
    return { text: raw, json: obj(parsed) }
  } catch {
    return { text: raw, json: null }
  }
}

/**
 * Codex's `exec` runs JavaScript that calls its other tools; the first one it calls names it, with
 * the command when that is one.
 */
function execAction(code: string): { kind: RequestActionKind; label: string } {
  const call = /tools\.([A-Za-z0-9_$.]+)\(([\s\S]{0,400})/.exec(code)
  if (!call) return { kind: 'run', label: 'exec' }
  const tool = call[1]
  if (tool === 'exec_command' || tool === 'write_stdin') {
    // A literal command, or the first of a list the code runs one by one.
    const command =
      /\b(?:cmd|chars)\s*:\s*["'`]([^"'`]+)/.exec(call[2])?.[1] ??
      /\bcmd\s*=\s*["'`]([^"'`]+)/.exec(code)?.[1] ??
      /\bcmds?\s*=\s*\[\s*["'`]([^"'`]+)/.exec(code)?.[1]
    return { kind: 'run', label: command ? preview(command).slice(0, 60) : tool }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) return { kind: 'tool', label: mcp[2] }
  if (tool.startsWith('web')) return { kind: 'web', label: tool }
  return { kind: 'tool', label: tool }
}

/** What a Codex tool call did, named for a row. */
export function codexAction(
  name: string,
  input: { text: string; json: Rec | null },
): {
  kind: RequestActionKind
  label: string
} {
  const command = input.json?.command ?? input.json?.cmd
  const shown = Array.isArray(command) ? command.join(' ') : str(command)
  switch (name) {
    case 'shell':
    case 'exec_command':
    case 'container.exec':
    case 'local_shell':
      return { kind: 'run', label: shown ? preview(shown).slice(0, 60) : name }
    case 'exec':
      return execAction(input.text)
    case 'apply_patch': {
      const file = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(input.text)?.[1]
      return { kind: 'edit', label: file ? `apply_patch ${file.split('/').pop()}` : 'apply_patch' }
    }
    case 'web_search':
      return { kind: 'web', label: 'web_search' }
    case 'view_image':
      return { kind: 'read', label: 'view_image' }
  }
  return { kind: 'tool', label: name }
}

interface Pending {
  parts: RequestPart[]
  ranges: [number, number][]
  actions: { kind: RequestActionKind; label: string; tool?: string }[]
}

const empty = (): Pending => ({ parts: [], ranges: [], actions: [] })

/** The rollout's lines in file order into turns of requests, oldest first. */
export function parseCodexRollout(lines: TranscriptLine[]): ParsedTranscript {
  const turns: RequestTurn[] = []
  const turnById = new Map<string, RequestTurn>()
  const requests = new Map<string, ParsedRequest>()
  const byUsageRecord = lines.some((line) => line.record.type === 'token_usage_record')
  let turn: RequestTurn | null = null
  let model: string | null = null
  let params: RequestParam[] = []
  let sent = empty()
  let received = empty()
  let lastAt: number | null = null
  let lastTotal: string | null = null

  const ensureTurn = (id: string): RequestTurn => {
    const known = turnById.get(id)
    if (known) return known
    const made: RequestTurn = { id, index: null, prompt: '', startedAt: null, requests: [] }
    turnById.set(id, made)
    turns.push(made)
    return made
  }

  const close = (
    id: string,
    turnId: string | null,
    tokens: RequestTokens,
    at: number | null,
    range: [number, number] | null,
    running = false,
  ): void => {
    const t = turnId ? ensureTurn(turnId) : (turn ?? ensureTurn(`before:${id}`))
    const ranges = [...sent.ranges, ...received.ranges, ...(range ? [range] : [])].sort(
      (a, b) => a[0] - b[0],
    )
    const request: ParsedRequest = {
      request: {
        id,
        turnId: t.id,
        sentAt: lastAt,
        endedAt: running ? null : at,
        model,
        params,
        requestId: running ? null : id,
        stop: null,
        tokens,
        actions: summarizeActions(received.actions),
        sent: sent.parts,
        received: received.parts,
        kept: null,
        added: null,
        status: running ? 'running' : 'done',
        error: null,
        records: ranges.length,
        raw: encodeRanges(ranges),
      },
      ranges,
    }
    requests.set(id, request)
    t.requests.push(request.request)
    sent = empty()
    received = empty()
    lastAt = at
  }

  for (const line of lines) {
    const r = line.record
    const p = obj(r.payload) ?? {}
    const at = time(r.timestamp)
    const range: [number, number] = [line.start, line.end]
    const kind = str(p.type)
    if (r.type === 'turn_context') {
      const id = str(p.turn_id)
      if (id) {
        turn = ensureTurn(id)
        turn.startedAt ??= at
      }
      const settings = obj(obj(p.collaboration_mode)?.settings)
      model = str(p.model) ?? str(settings?.model) ?? model
      const effort = str(p.effort) ?? str(settings?.reasoning_effort)
      const summary = str(p.summary)
      const approval = str(p.approval_policy)
      const sandbox = str(obj(p.sandbox_policy)?.type)
      params = [
        ...(effort ? [{ name: 'effort', value: effort }] : []),
        ...(summary ? [{ name: 'summary', value: summary }] : []),
        ...(sandbox ? [{ name: 'sandbox', value: sandbox }] : []),
        ...(approval ? [{ name: 'approval', value: approval }] : []),
      ]
      continue
    }
    if (r.type === 'event_msg') {
      if (kind === 'task_started') {
        const id = str(p.turn_id)
        if (id) {
          turn = ensureTurn(id)
          turn.startedAt ??= at
        }
        lastAt = at
      } else if (kind === 'user_message' && turn && !turn.prompt) {
        turn.prompt = preview(str(p.message) ?? '')
      } else if (kind === 'item_completed' && turn && !turn.prompt) {
        const item = obj(p.item)
        if (item?.type === 'UserMessage') turn.prompt = preview(textOf(item.content))
      } else if (kind === 'token_count' && !byUsageRecord) {
        const info = obj(p.info)
        const last = obj(info?.last_token_usage)
        const total = JSON.stringify(info?.total_token_usage ?? null)
        // Codex repeats the count when nothing new was used, as after a tool runs.
        if (!last || total === lastTotal) continue
        lastTotal = total
        close(`count:${line.start}`, null, codexTokens(last), at, range)
      }
      continue
    }
    if (r.type === 'token_usage_record') {
      const id = str(p.response_id) ?? `usage:${line.start}`
      close(id, str(p.turn_id), codexTokens(obj(p.usage)), at, range)
      continue
    }
    if (r.type !== 'response_item') continue
    const meta = obj(p.internal_chat_message_metadata_passthrough)
    const itemTurn = str(meta?.turn_id)
    if (!turn && itemTurn) turn = ensureTurn(itemTurn)
    switch (kind) {
      case 'message': {
        const text = textOf(p.content)
        const role = str(p.role)
        if (role === 'assistant') {
          received.parts.push({
            kind: 'text',
            label: 'text',
            preview: preview(text),
            bytes: utf8Length(text),
          })
          received.actions.push({ kind: 'reply', label: 'Reply' })
          received.ranges.push(range)
        } else {
          const kinds = arr(meta?.content_item_kinds).map(str)
          const label = role === 'user' && !text.trimStart().startsWith('<') ? 'prompt' : null
          sent.parts.push(
            label
              ? { kind: 'prompt', label: 'prompt', preview: preview(text), bytes: utf8Length(text) }
              : {
                  kind: 'other',
                  label: kinds.includes('model.base_instructions')
                    ? 'instructions'
                    : (role ?? 'message'),
                  preview: preview(text),
                  bytes: utf8Length(text),
                },
          )
          sent.ranges.push(range)
          lastAt = at
        }
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const output = typeof p.output === 'string' ? p.output : textOf(p.output)
        sent.parts.push({
          kind: 'tool-result',
          label: 'tool_result',
          preview: preview(output),
          bytes: utf8Length(output),
        })
        sent.ranges.push(range)
        lastAt = at
        break
      }
      case 'additional_tools':
      case 'configuration_update': {
        const tools = arr(p.tools)
        sent.parts.push({
          kind: 'other',
          label: kind,
          preview:
            kind === 'additional_tools'
              ? tools.map((t) => str(obj(t)?.name) ?? '').join(', ')
              : preview(JSON.stringify(p)),
          bytes: null,
        })
        sent.ranges.push(range)
        break
      }
      case 'reasoning': {
        const summary = arr(p.summary)
          .map((s) => str(obj(s)?.text) ?? '')
          .join(' ')
        received.parts.push({
          kind: 'thinking',
          label: 'reasoning',
          preview: preview(summary),
          bytes: null,
        })
        received.actions.push({ kind: 'thinking', label: 'Thinking' })
        received.ranges.push(range)
        break
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'web_search_call': {
        const name =
          str(p.name) ??
          (kind === 'local_shell_call'
            ? 'local_shell'
            : kind === 'web_search_call'
              ? 'web_search'
              : 'tool')
        const input = callInput(
          kind === 'local_shell_call' ? { arguments: JSON.stringify(p.action ?? {}) } : p,
        )
        const action = codexAction(name, input)
        received.parts.push({
          kind: 'tool-call',
          label: str(p.namespace) ?? name,
          preview: preview(action.label === name ? input.text : action.label),
          bytes: input.text ? utf8Length(input.text) : null,
        })
        received.actions.push({ ...action, tool: name })
        received.ranges.push(range)
        break
      }
    }
  }
  // Outputs with no count yet: the request in flight.
  if (received.ranges.length > 0) {
    const start = received.ranges[0][0]
    close(`running:${start}`, null, emptyTokens(), null, null, true)
  }
  return { turns, requests }
}

/** The base and developer instructions and the tools Codex keeps in a rollout. */
export function summarizeCodexSystem(input: {
  base: string | null
  developer: string | null
  tools: { at: number | null; namespaces: Rec[] }[]
}): RequestsSystem | null {
  const latest = input.tools.at(-1)
  if (!input.base && !input.developer && !latest) return null
  const names = (namespaces: Rec[]): string[] =>
    namespaces.flatMap((ns) =>
      arr(ns.tools).map((tool) => `${str(ns.name) ?? ''}/${str(obj(tool)?.name) ?? ''}`),
    )
  const groups: RequestsToolGroup[] = (latest?.namespaces ?? []).map((ns) => {
    const name = str(ns.name) ?? 'tools'
    const mcp = /^mcp__(.+)$/.exec(name)
    return {
      kind: name === 'functions' ? 'builtin' : mcp ? 'mcp' : 'other',
      name: name === 'functions' ? 'builtin' : (mcp?.[1] ?? name),
      tools: arr(ns.tools).map((tool) => str(obj(tool)?.name) ?? ''),
    }
  })
  const changes = []
  for (let i = 1; i < input.tools.length; i++) {
    const before = new Set(names(input.tools[i - 1].namespaces))
    const after = new Set(names(input.tools[i].namespaces))
    const strip = (n: string) => n.split('/').pop() ?? n
    const added = [...after].filter((n) => !before.has(n)).map(strip)
    const removed = [...before].filter((n) => !after.has(n)).map(strip)
    if (added.length || removed.length) changes.push({ at: input.tools[i].at, added, removed })
  }
  return {
    kind: 'instructions',
    blocks: [input.base, input.developer]
      .filter((text): text is string => !!text)
      .map((text) => ({ preview: preview(text), chars: text.length })),
    groups,
    toolCount: latest ? groups.reduce((sum, g) => sum + g.tools.length, 0) : null,
    changes,
  }
}
