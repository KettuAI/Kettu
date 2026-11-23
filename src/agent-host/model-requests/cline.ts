// The Requests pane's reading of a Cline session, from the messages file Cline keeps for it
// (`<data>/sessions/<id>/<id>.messages.json`, cline 3.0.74): each assistant message is one request
// to the model, with its model and tokens, and what came before it is what the request added.

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  REQUESTS_PAGE,
  utf8Length,
  type ModelRequest,
  type ModelRequestsOverview,
  type RequestActionKind,
  type RequestPart,
  type RequestTokens,
  type RequestTurn,
} from '@shared/model-requests'
import type { Env } from '../find-command'
import { t } from '../i18n'
import { withoutKettu } from './acp-messages'
import { arr, emptyTokens, num, obj, preview, str, summarizeActions } from './claude-transcript'
import { foldAll, type ModelRequestsReader, type RequestsTarget } from './reader'

type Rec = Record<string, unknown>

/** Cline's own tools by what they do; any other is an MCP server's or a plugin's. */
const TOOL_KINDS: Readonly<Record<string, RequestActionKind>> = {
  read_files: 'read',
  search_codebase: 'search',
  editor: 'edit',
  apply_patch: 'edit',
  run_commands: 'run',
  fetch_web_content: 'web',
  web_search: 'web',
  spawn_agent: 'agent',
}

const SYSTEM = 'system'

/** Where Cline keeps a session's messages, as its own variables move its folders. */
export function clineMessagesFile(env: Env, home: string, sessionId: string): string {
  const variable = (name: string): string | null => env[name]?.trim() || null
  const sessions =
    variable('CLINE_SESSION_DATA_DIR') ??
    path.join(
      variable('CLINE_DATA_DIR') ??
        path.join(variable('CLINE_DIR') ?? path.join(home, '.cline'), 'data'),
      'sessions',
    )
  return path.join(sessions, sessionId, `${sessionId}.messages.json`)
}

/**
 * The user's own words of a message, without the mode tag Cline wraps them in and what Kettu
 * sends ahead of them in its own tags.
 */
function userText(text: string): string {
  return withoutKettu(
    text
      .replace(/<\/?user_input[^>]*>/g, ' ')
      .replace(/<mode_notice>[\s\S]*?<\/mode_notice>/g, ' '),
  )
}

function blockText(value: unknown): string {
  if (typeof value === 'string') return value
  return value === undefined ? '' : JSON.stringify(value)
}

function tokens(metrics: Rec | null): RequestTokens {
  if (!metrics) return emptyTokens()
  const read = num(metrics.cacheReadTokens)
  const written = num(metrics.cacheWriteTokens)
  const input = num(metrics.inputTokens)
  const cached = (read ?? 0) + (written ?? 0)
  return {
    // Cline's input count holds what the cache served and took, unless it is under it.
    input: input === null ? null : input >= cached ? input - cached : input,
    cacheRead: read,
    cacheWrite: written,
    cacheWrite1h: null,
    output: num(metrics.outputTokens),
    reasoning: null,
  }
}

/** What a user message sent: the prompt, files Cline read into it, and tool results. */
function sentParts(message: Rec): RequestPart[] {
  return arr(message.content).flatMap((item): RequestPart[] => {
    const block = obj(item)
    if (!block) return []
    if (block.type === 'tool_result') {
      const text = blockText(block.content)
      return [
        {
          kind: 'tool-result',
          label: str(block.name) ?? 'tool',
          preview: preview(text),
          bytes: utf8Length(text),
          ...(block.is_error === true ? { error: true } : {}),
        },
      ]
    }
    if (block.type === 'text') {
      const text = str(block.text) ?? ''
      const file = /^<file_content path="([^"]*)">/.exec(text)
      if (file) {
        return [
          {
            kind: 'attachment',
            label: path.basename(file[1]!),
            preview: '',
            bytes: utf8Length(text),
          },
        ]
      }
      return [
        {
          kind: 'prompt',
          label: 'Prompt',
          preview: preview(userText(text)),
          bytes: utf8Length(text),
        },
      ]
    }
    if (block.type === 'image')
      return [{ kind: 'attachment', label: 'Image', preview: '', bytes: null }]
    return []
  })
}

/** Whether a user message is the user's own, rather than only the results of tool calls. */
function isPrompt(message: Rec): boolean {
  return arr(message.content).some((item) => obj(item)?.type === 'text')
}

function promptText(message: Rec): string {
  const text = arr(message.content)
    .flatMap((item) => (obj(item)?.type === 'text' ? [str(obj(item)!.text) ?? ''] : []))
    .find((item) => !item.startsWith('<file_content '))
  return preview(userText(text ?? ''))
}

/** A session's turns, oldest first: each of the user's messages, and the requests it led to. */
export function clineTurns(messages: readonly unknown[]): RequestTurn[] {
  const turns: RequestTurn[] = []
  let turn: RequestTurn | null = null
  /** The user messages since the last request, which the next one sends. */
  let sent: { message: Rec; index: number }[] = []
  messages.forEach((item, index) => {
    const message = obj(item)
    if (!message) return
    if (message.role === 'user') {
      if (isPrompt(message)) {
        turn = {
          id: str(message.id) ?? `turn-${index}`,
          index: turns.length + 1,
          prompt: promptText(message),
          startedAt: num(message.ts),
          requests: [],
        }
        turns.push(turn)
      }
      sent.push({ message, index })
      return
    }
    if (message.role !== 'assistant') return
    if (!turn) {
      turn = {
        id: `turn-${index}`,
        index: turns.length + 1,
        prompt: '',
        startedAt: null,
        requests: [],
      }
      turns.push(turn)
    }
    const seen: { kind: RequestActionKind; label: string; tool?: string }[] = []
    const received: RequestPart[] = []
    for (const part of arr(message.content)) {
      const block = obj(part)
      if (!block) continue
      if (block.type === 'thinking') {
        const text = str(block.thinking) ?? ''
        seen.push({ kind: 'thinking', label: 'Thinking' })
        received.push({
          kind: 'thinking',
          label: 'Thinking',
          preview: preview(text),
          bytes: utf8Length(text),
        })
      } else if (block.type === 'text') {
        const text = str(block.text) ?? ''
        seen.push({ kind: 'reply', label: 'Reply' })
        received.push({
          kind: 'text',
          label: 'Reply',
          preview: preview(text),
          bytes: utf8Length(text),
        })
      } else if (block.type === 'tool_use') {
        const name = str(block.name) ?? 'tool'
        const input = blockText(block.input)
        const tool = name.includes('__') ? name.slice(name.indexOf('__') + 2) : name
        seen.push({ kind: TOOL_KINDS[name] ?? 'tool', label: tool, tool })
        received.push({
          kind: 'tool-call',
          label: name,
          preview: preview(input),
          bytes: utf8Length(input),
        })
      }
    }
    const first = sent[0]?.index ?? index
    const request: ModelRequest = {
      id: str(message.id) ?? `request-${index}`,
      turnId: turn.id,
      sentAt: num(sent.at(-1)?.message.ts),
      endedAt: num(message.ts),
      model: str(obj(message.modelInfo)?.id),
      params: [],
      requestId: null,
      stop: null,
      tokens: tokens(obj(message.metrics)),
      actions: summarizeActions(seen),
      sent: sent.flatMap((item) => sentParts(item.message)),
      received,
      kept: null,
      added: null,
      status: 'done',
      error: null,
      records: index - first + 1,
      raw: `${first}-${index + 1}`,
    }
    turn.requests.push(request)
    sent = []
  })
  return turns
}

function addTokens(sum: RequestTokens | null, next: RequestTokens): RequestTokens | null {
  if (next.input === null && next.output === null) return sum
  const add = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0)
  const base = sum ?? emptyTokens()
  return {
    input: add(base.input, next.input),
    cacheRead: add(base.cacheRead, next.cacheRead),
    cacheWrite: add(base.cacheWrite, next.cacheWrite),
    cacheWrite1h: null,
    output: add(base.output, next.output),
    reasoning: null,
  }
}

/** The newest turns holding up to a page of requests, and where the page before them ends. */
function pageOf(
  turns: RequestTurn[],
  end: number,
): { turns: RequestTurn[]; before: string | null } {
  let start = end
  let requests = 0
  while (start > 0 && requests < REQUESTS_PAGE) {
    start -= 1
    requests += turns[start]!.requests.length
  }
  return { turns: turns.slice(start, end), before: start > 0 ? String(start) : null }
}

export function clineModelRequests(deps: {
  home: string
  env(): Promise<Env>
}): ModelRequestsReader {
  const read = async (target: RequestsTarget): Promise<Rec | null> => {
    const file = clineMessagesFile(await deps.env(), deps.home || os.homedir(), target.acpSessionId)
    try {
      return obj(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      // Cline writes the file with the session's first reply.
      return null
    }
  }
  return {
    async page(target, before) {
      const record = await read(target)
      if (!record) return null
      const turns = clineTurns(arr(record.messages))
      const end = before === null ? turns.length : Math.min(turns.length, Number(before) || 0)
      return { source: 'cline', ...pageOf(turns, end) }
    },

    async summary(target): Promise<ModelRequestsOverview | null> {
      const record = await read(target)
      if (!record) return null
      const messages = arr(record.messages)
      const turns = clineTurns(messages)
      const requests = turns.flatMap((turn) => turn.requests)
      let cost: number | null = null
      for (const message of messages) {
        const spent = num(obj(obj(message)?.metrics)?.cost)
        if (spent !== null) cost = (cost ?? 0) + spent
      }
      const prompt = str(record.system_prompt)
      return {
        source: 'cline',
        requests: requests.length,
        // Cline counts 0 for a model it has no price for.
        costUsd: cost ? cost : null,
        tokens: requests.reduce<RequestTokens | null>((sum, r) => addTokens(sum, r.tokens), null),
        system: prompt
          ? {
              kind: 'system',
              blocks: [{ preview: preview(prompt), chars: prompt.length }],
              groups: [],
              toolCount: null,
              changes: [],
            }
          : null,
        turns: Object.fromEntries(turns.map((turn, index) => [turn.id, index + 1])),
      }
    },

    async raw(target, raw, full) {
      const record = await read(target)
      if (!record) throw new Error(t('modelRequest.noClineMessages'))
      if (raw === SYSTEM) return foldAll([{ system_prompt: record.system_prompt ?? null }], full)
      const match = /^(\d+)-(\d+)$/.exec(raw)
      if (!match) throw new Error('Not a request of this session')
      return foldAll(arr(record.messages).slice(Number(match[1]), Number(match[2])), full)
    },
  }
}
