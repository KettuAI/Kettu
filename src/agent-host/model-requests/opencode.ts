// Reads an OpenCode session's requests through OpenCode's own API: each assistant message is one
// request to the model, with its own tokens and cost. OpenCode pages messages newest first; a page
// here starts at a user's message, so no turn is split between two pages.

import {
  REQUESTS_PAGE,
  utf8Length,
  type ModelRequest,
  type ModelRequestsOverview,
  type ModelRequestsPage,
  type RequestActionKind,
  type RequestPart,
  type RequestTokens,
  type RequestTurn,
} from '@shared/model-requests'
import type { AgentId } from '@shared/thread'
import { t } from '../i18n'
import { arr, num, obj, preview, str, summarizeActions } from './claude-transcript'
import { foldAll, type ModelRequestsReader } from './reader'

type Rec = Record<string, unknown>

/** What the reader asks of OpenCode for one agent. */
export interface OpenCodeSessions {
  /** A page of a session's messages, newest first, and the cursor of the older ones. */
  messages(
    sessionId: string,
    cursor: string | null,
  ): Promise<{ messages: unknown[]; next: string | null } | null>
  message(sessionId: string, messageId: string): Promise<unknown>
  session(sessionId: string): Promise<Record<string, unknown> | null>
}

/** How many of OpenCode's pages one read takes at most, looking for the start of a turn. */
const PAGES = 8
// A fork's copied messages end in `_` and a number.
const MESSAGE_IDS = /^msg_[A-Za-z0-9_]+(,msg_[A-Za-z0-9_]+)*$/

/** The cursor of the messages older than one, made the way OpenCode makes its own. */
export function cursorBefore(messageId: string): string {
  return btoa(JSON.stringify({ id: messageId, order: 'desc', direction: 'next' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function openCodeTokens(tokens: Rec | null): RequestTokens {
  const cache = obj(tokens?.cache)
  return {
    input: num(tokens?.input),
    cacheRead: num(cache?.read),
    cacheWrite: num(cache?.write),
    cacheWrite1h: null,
    output: num(tokens?.output),
    reasoning: num(tokens?.reasoning),
  }
}

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** What an OpenCode tool call did, named for a row, and the input that says what it acted on. */
function toolAction(
  name: string,
  input: Rec | null,
): { kind: RequestActionKind; label: string; detail: string | null } {
  const file = str(input?.path) ?? str(input?.filePath)
  switch (name) {
    case 'shell':
    case 'bash': {
      const command = str(input?.command)
      return { kind: 'run', label: command ? preview(command).slice(0, 60) : name, detail: command }
    }
    case 'read':
    case 'edit':
    case 'write':
    case 'patch':
      return {
        kind: name === 'read' ? 'read' : 'edit',
        label: file ? `${name} ${basename(file)}` : name,
        detail: file,
      }
    case 'grep':
    case 'glob':
    case 'list': {
      const pattern = str(input?.pattern)
      return {
        kind: 'search',
        label: pattern ? `${name} ${pattern.slice(0, 60)}` : name,
        detail: pattern,
      }
    }
    case 'webfetch':
    case 'websearch':
      return { kind: 'web', label: name, detail: str(input?.url) ?? str(input?.query) }
    case 'subagent':
    case 'task': {
      const agent = str(input?.agent) ?? str(input?.description)
      return {
        kind: 'agent',
        label: agent ? `${name} ${agent}` : name,
        detail: str(input?.description) ?? agent,
      }
    }
    case 'execute': {
      // Code Mode runs JavaScript that calls OpenCode's tools; the first it calls names it.
      const code = str(input?.code)
      const call = /tools\.([A-Za-z0-9_$.]+)\(/.exec(code ?? '')
      return { kind: 'tool', label: call ? call[1] : name, detail: code }
    }
  }
  return { kind: 'tool', label: name, detail: null }
}

const textPart = (kind: RequestPart['kind'], label: string, text: string): RequestPart => ({
  kind,
  label,
  preview: preview(text),
  bytes: utf8Length(text),
})

/** A user's message as it went to the model: its words and the files with it. */
function userParts(m: Rec): RequestPart[] {
  const parts = [textPart('prompt', 'prompt', str(m.text) ?? '')]
  for (const file of arr(m.files)) {
    const f = obj(file)
    if (!f) continue
    const data = str(f.data)
    parts.push({
      kind: 'attachment',
      label: str(f.mime) ?? 'file',
      preview: str(f.name) ?? '',
      // Inline files are base64.
      bytes: data ? Math.floor((data.length * 3) / 4) : null,
    })
  }
  return parts
}

/** One assistant message: what came back, the tool results the next request sends, and its row. */
function assistantParts(m: Rec): {
  received: RequestPart[]
  results: RequestPart[]
  seen: { kind: RequestActionKind; label: string; tool?: string }[]
} {
  const received: RequestPart[] = []
  const results: RequestPart[] = []
  const seen: { kind: RequestActionKind; label: string; tool?: string }[] = []
  for (const part of arr(m.content)) {
    const p = obj(part)
    if (!p) continue
    if (p.type === 'reasoning') {
      received.push({ ...textPart('thinking', 'reasoning', str(p.text) ?? ''), bytes: null })
      seen.push({ kind: 'thinking', label: 'Thinking' })
    } else if (p.type === 'text') {
      received.push(textPart('text', 'text', str(p.text) ?? ''))
      seen.push({ kind: 'reply', label: 'Reply' })
    } else if (p.type === 'tool') {
      const name = str(p.name) ?? 'tool'
      const state = obj(p.state)
      const input = obj(state?.input)
      const { kind, label, detail } = toolAction(name, input)
      const json = input ? JSON.stringify(input) : ''
      received.push({
        kind: 'tool-call',
        label: name,
        preview: preview(detail ?? json),
        bytes: json ? utf8Length(json) : null,
      })
      seen.push({ kind, label, tool: name })
      const failed = state?.status === 'error'
      const output = failed
        ? (str(obj(state?.error)?.message) ?? str(state?.error) ?? '')
        : arr(state?.content)
            .map((c) => str(obj(c)?.text) ?? '')
            .join('\n')
      if (output || failed) {
        results.push({ ...textPart('tool-result', name, output), error: failed || undefined })
      }
    }
  }
  return { received, results, seen }
}

/** OpenCode's messages, oldest first, as turns of requests. */
export function parseOpenCodeMessages(messages: Rec[]): RequestTurn[] {
  const turns: RequestTurn[] = []
  let turn: RequestTurn | null = null
  // What the next request sends, and the records it comes from.
  let sent: RequestPart[] = []
  let sentIds: string[] = []
  for (const m of messages) {
    const id = str(m.id)
    if (!id) continue
    const time = obj(m.time)
    switch (m.type) {
      case 'user':
        turn = {
          id,
          index: null,
          prompt: preview(str(m.text) ?? ''),
          startedAt: num(time?.created),
          requests: [],
        }
        turns.push(turn)
        sent.push(...userParts(m))
        sentIds.push(id)
        continue
      case 'system':
      case 'synthetic':
        // Instructions OpenCode adds, which go to the model with the next request.
        sent.push({
          ...textPart('other', m.type, str(m.text) ?? ''),
          preview: preview(str(m.description) ?? str(m.text) ?? ''),
        })
        sentIds.push(id)
        continue
      case 'assistant':
        break
      default:
        // Markers such as the end of a turn or a model switch, which the model never sees.
        continue
    }
    if (!turn) {
      // The page starts inside a turn whose prompt lies further back.
      turn = { id: `from:${id}`, index: null, prompt: '', startedAt: null, requests: [] }
      turns.push(turn)
    }
    const { received, results, seen } = assistantParts(m)
    const cost = num(m.cost)
    const model = obj(m.model)
    const agent = str(m.agent)
    const provider = str(model?.providerID)
    const completed = num(time?.completed)
    const error = obj(m.error)
    const failed = error || m.finish === 'error' ? (str(error?.message) ?? 'error') : null
    const request: ModelRequest = {
      id,
      turnId: turn.id,
      sentAt: num(time?.created),
      endedAt: completed,
      model: str(model?.id),
      params: [
        ...(agent ? [{ name: 'agent', value: agent }] : []),
        ...(provider ? [{ name: 'provider', value: provider }] : []),
        ...(cost ? [{ name: 'cost', value: `$${cost.toFixed(4)}` }] : []),
      ],
      requestId: null,
      stop: str(m.finish),
      tokens: openCodeTokens(obj(m.tokens)),
      actions: summarizeActions(seen),
      sent,
      received,
      kept: null,
      added: null,
      status: failed ? 'failed' : completed === null ? 'running' : 'done',
      error: failed,
      records: sentIds.length + 1,
      raw: [...sentIds, id].join(','),
    }
    turn.requests.push(request)
    sent = results
    sentIds = []
  }
  return turns
}

const REQUEST_TYPES = new Set<unknown>(['user', 'assistant'])

/** In messages newest first, the newest prompt with a page's worth of requests after it, or -1. */
function turnStart(newest: Rec[]): number {
  let requests = 0
  for (let i = 0; i < newest.length; i++) {
    const type = newest[i]!.type
    if (type === 'assistant') requests += 1
    else if (type === 'user' && requests >= REQUESTS_PAGE) return i
  }
  return -1
}

/** Reads back from `before` until a page holds a page's worth of requests and starts a turn. */
async function readPage(
  sessions: OpenCodeSessions,
  sessionId: string,
  before: string | null,
): Promise<ModelRequestsPage | null> {
  const newest: Rec[] = []
  let cursor = before
  let older: string | null = null
  for (let pages = 0; pages < PAGES; pages++) {
    const page = await sessions.messages(sessionId, cursor)
    if (!page) {
      if (pages === 0) return null
      break
    }
    for (const m of page.messages) {
      const message = obj(m)
      if (message) newest.push(message)
    }
    older = page.next
    let start = turnStart(newest)
    if (start >= 0) {
      // Instructions just before the prompt went out with its first request too.
      while (start + 1 < newest.length && !REQUEST_TYPES.has(newest[start + 1]!.type)) start += 1
      // What is older than the turn's prompt is the next page's.
      const kept = newest.slice(0, start + 1).reverse()
      const more = start < newest.length - 1 || older !== null
      return {
        source: 'opencode',
        turns: parseOpenCodeMessages(kept),
        before: more ? cursorBefore(str(kept[0]!.id)!) : null,
      }
    }
    if (!older) break
    cursor = older
  }
  return { source: 'opencode', turns: parseOpenCodeMessages(newest.reverse()), before: older }
}

export function opencodeModelRequests(deps: {
  sessions(agentId: AgentId): OpenCodeSessions | null
}): ModelRequestsReader {
  return {
    async page(target, before) {
      const sessions = deps.sessions(target.agentId)
      return sessions ? readPage(sessions, target.acpSessionId, before) : null
    },

    async summary(target): Promise<ModelRequestsOverview | null> {
      const session = await deps.sessions(target.agentId)?.session(target.acpSessionId)
      if (!session) return null
      const cost = num(session.cost)
      return {
        source: 'opencode',
        // OpenCode counts the session's tokens and cost but not its requests.
        requests: null,
        // It counts 0 for a model it has no price for.
        costUsd: cost ? cost : null,
        tokens: openCodeTokens(obj(session.tokens)),
        // It keeps no system prompt or tools, only the instructions it adds, shown where they went.
        system: null,
        turns: null,
      }
    },

    async raw(target, raw, full) {
      const sessions = deps.sessions(target.agentId)
      if (!sessions) throw new Error(t('modelRequest.noRecord'))
      if (!MESSAGE_IDS.test(raw)) throw new Error('Not a request of this session')
      const records = await Promise.all(
        raw.split(',').map((id) => sessions.message(target.acpSessionId, id)),
      )
      if (records.some((r) => r === null)) {
        throw new Error(t('modelRequest.openCodeGone'))
      }
      return foldAll(records, full)
    },
  }
}
