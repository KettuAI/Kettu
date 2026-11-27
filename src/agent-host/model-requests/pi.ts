// Reads a Pi session's per-request model breakdowns from its JSONL session file, newest page
// first, reusing the backward page reader so long sessions cost no more than short ones.

import { realpath, stat } from 'node:fs/promises'
import type { Platform } from '@shared/platform'
import {
  REQUESTS_PAGE,
  utf8Length,
  type ModelRequest,
  type ModelRequestsOverview,
  type RequestActionKind,
  type RequestParam,
  type RequestPart,
  type RequestTokens,
  type RequestTurn,
  type RequestsSystem,
  type RequestsSystemBlock,
  type RequestsToolChange,
  type RequestsToolGroup,
} from '@shared/model-requests'
import { harnessOf, type AgentId } from '@shared/thread'
import type { Env } from '../find-command'
import { t } from '../i18n'
import { typedText } from '../pi/mapper'
import { findSessionFile, piFolders } from '../pi/session-files'
import {
  confirmedPiCost,
  parseEpochMs,
  parseIsoMs,
  parsePiTimes,
  parsePiUsage,
  piModelName,
  piProviderName,
} from '../pi/usage'
import { withoutAhead } from '../session-updates'
import { eachLine, fileSource, openLog } from '../usage/lines'
import {
  arr,
  emptyTokens,
  encodeRanges,
  obj,
  preview,
  str,
  summarizeActions,
  type TranscriptLine,
} from './claude-transcript'
import { parseLines, readPageFrom, type PageRules } from './pages'
import { foldAll, readRanges, type ModelRequestsReader, type RequestsTarget } from './reader'

type Rec = Record<string, unknown>

const REMEMBERED = 200
const SUMMARY_CACHE = 20
const SYSTEM_RAW = 'system'

const ASSISTANT_MARKER = Buffer.from('"assistant"')
const USER_MARKER = Buffer.from('"user"')

const basename = (file: string): string => file.split(/[\\/]/).filter(Boolean).pop() ?? file

function nonEmpty(value: unknown): string | null {
  const valueStr = str(value)?.trim()
  return valueStr ? valueStr : null
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content)
    .map((item) => {
      const block = obj(item)
      if (!block) return ''
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (block.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function formatArgs(args: unknown): string {
  if (typeof args === 'string') return args
  if (args === undefined || args === null) return ''
  try {
    return JSON.stringify(args)
  } catch {
    return ''
  }
}

function piToolAction(
  name: string,
  args: Rec | null,
): { kind: RequestActionKind; label: string; tool: string } {
  const file = nonEmpty(args?.path) ?? nonEmpty(args?.file_path)
  switch (name) {
    case 'read':
      return { kind: 'read', label: file ? `read ${basename(file)}` : 'read', tool: name }
    case 'write':
    case 'edit':
      return { kind: 'edit', label: file ? `${name} ${basename(file)}` : name, tool: name }
    case 'bash':
    case 'powershell': {
      const command = nonEmpty(args?.command)
      return {
        kind: 'run',
        label: command ? `${name} ${preview(command).slice(0, 60)}` : name,
        tool: name,
      }
    }
    case 'codemode':
      return { kind: 'run', label: 'codemode', tool: name }
    case 'grep':
    case 'find':
    case 'ls':
    case 'tool_search': {
      const pattern = nonEmpty(args?.pattern) ?? nonEmpty(args?.query) ?? file
      return {
        kind: 'search',
        label: pattern ? `${name} ${pattern.slice(0, 60)}` : name,
        tool: name,
      }
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  const label = mcp ? mcp[2]! : name
  return { kind: 'tool', label, tool: name }
}

function piRequestTokens(rawUsage: unknown): RequestTokens {
  const parsed = parsePiUsage(rawUsage)
  if (!parsed) return emptyTokens()
  return {
    input: parsed.input,
    cacheRead: parsed.cacheRead,
    cacheWrite: parsed.cacheWrite,
    cacheWrite1h: null,
    output: parsed.output,
    reasoning: parsed.reasoning,
  }
}

function addTokens(sum: RequestTokens | null, next: RequestTokens): RequestTokens | null {
  if (
    next.input === null &&
    next.cacheRead === null &&
    next.cacheWrite === null &&
    next.output === null &&
    next.reasoning === null
  ) {
    return sum
  }
  const add = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0)
  const base = sum ?? emptyTokens()
  return {
    input: add(base.input, next.input),
    cacheRead: add(base.cacheRead, next.cacheRead),
    cacheWrite: add(base.cacheWrite, next.cacheWrite),
    cacheWrite1h: null,
    output: add(base.output, next.output),
    reasoning: add(base.reasoning, next.reasoning),
  }
}

function userPromptText(content: unknown): string {
  if (typeof content === 'string') return preview(typedText(withoutAhead(content)))
  const texts: string[] = []
  let hasImage = false
  for (const item of arr(content)) {
    const block = obj(item)
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      const cleaned = typedText(withoutAhead(block.text)).trim()
      if (cleaned) texts.push(cleaned)
    } else if (block.type === 'image') {
      hasImage = true
    }
  }
  if (texts.length > 0) return preview(texts.join(' '))
  return hasImage ? '[image]' : ''
}

function sentPartsOf(record: Rec): RequestPart[] {
  if (record.type === 'compaction' || record.type === 'branch_summary') {
    const summary = str(record.summary) ?? ''
    if (!summary) return []
    return [
      {
        kind: 'other',
        label: record.type === 'compaction' ? 'compaction' : 'branch_summary',
        preview: preview(summary),
        bytes: utf8Length(summary),
      },
    ]
  }

  if (record.type === 'custom_message') {
    const text = textOfContent(record.content)
    if (!text) return []
    return [
      {
        kind: 'other',
        label: 'custom',
        preview: preview(text),
        bytes: utf8Length(text),
      },
    ]
  }

  if (record.type !== 'message') return []
  const message = obj(record.message)
  if (!message) return []

  switch (message.role) {
    case 'user': {
      const parts: RequestPart[] = []
      const rawContent = message.content
      if (typeof rawContent === 'string') {
        const cleaned = typedText(withoutAhead(rawContent))
        parts.push({
          kind: 'prompt',
          label: 'prompt',
          preview: preview(cleaned),
          bytes: utf8Length(rawContent),
        })
        return parts
      }
      const textChunks: string[] = []
      for (const item of arr(rawContent)) {
        const block = obj(item)
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          textChunks.push(block.text)
        } else if (block.type === 'image') {
          const data = str(block.data)
          parts.push({
            kind: 'attachment',
            label: str(block.mimeType) ?? 'image',
            preview: '[image]',
            bytes: data ? Math.floor((data.length * 3) / 4) : null,
          })
        }
      }
      const joined = textChunks.join('\n')
      if (joined !== '') {
        parts.unshift({
          kind: 'prompt',
          label: 'prompt',
          preview: preview(typedText(withoutAhead(joined))),
          bytes: utf8Length(joined),
        })
      }
      return parts
    }
    case 'toolResult': {
      const text = textOfContent(message.content)
      return [
        {
          kind: 'tool-result',
          label: nonEmpty(message.toolName) ?? 'tool_result',
          preview: preview(text),
          bytes: text ? utf8Length(text) : null,
          ...(message.isError === true ? { error: true } : {}),
        },
      ]
    }
    case 'bashExecution': {
      const command = str(message.command) ?? ''
      const output = str(message.output) ?? ''
      const combined = command && output ? `${command}\n${output}` : command || output
      const failed = typeof message.exitCode === 'number' && message.exitCode !== 0
      return [
        {
          kind: 'tool-result',
          label: 'bash',
          preview: preview(combined),
          bytes: combined ? utf8Length(combined) : null,
          ...(failed ? { error: true } : {}),
        },
      ]
    }
    case 'custom':
    case 'branchSummary':
    case 'compactionSummary': {
      const text = str(message.summary) ?? textOfContent(message.content)
      if (!text) return []
      return [
        {
          kind: 'other',
          label: String(message.role),
          preview: preview(text),
          bytes: utf8Length(text),
        },
      ]
    }
    default:
      return []
  }
}

function receivedPartsOf(message: Rec): {
  actions: ModelRequest['actions']
  received: RequestPart[]
} {
  const seen: { kind: RequestActionKind; label: string; tool?: string }[] = []
  const received: RequestPart[] = []
  const content = message.content

  if (typeof content === 'string') {
    if (content !== '') {
      seen.push({ kind: 'reply', label: 'Reply' })
      received.push({
        kind: 'text',
        label: 'text',
        preview: preview(content),
        bytes: utf8Length(content),
      })
    }
    return { actions: summarizeActions(seen), received }
  }

  for (const item of arr(content)) {
    const block = obj(item)
    if (!block) continue
    if (block.type === 'thinking') {
      const text = str(block.thinking) ?? ''
      seen.push({ kind: 'thinking', label: 'Thinking' })
      received.push({
        kind: 'thinking',
        label: 'thinking',
        preview: preview(text),
        bytes: text ? utf8Length(text) : null,
      })
    } else if (block.type === 'text') {
      const text = str(block.text) ?? ''
      if (text === '') continue
      seen.push({ kind: 'reply', label: 'Reply' })
      received.push({
        kind: 'text',
        label: 'text',
        preview: preview(text),
        bytes: utf8Length(text),
      })
    } else if (block.type === 'toolCall') {
      const name = nonEmpty(block.name) ?? 'tool'
      const args = obj(block.arguments)
      const action = piToolAction(name, args)
      const json = formatArgs(block.arguments)
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      seen.push(action)
      received.push({
        kind: 'tool-call',
        label: mcp ? mcp[1]! : name,
        preview: preview(action.label),
        bytes: json ? utf8Length(json) : null,
      })
    }
  }
  return { actions: summarizeActions(seen), received }
}

/**
 * Parses a slice of Pi JSONL session lines (in file order) into grouped turns and per-call model
 * requests. Each assistant message entry corresponds to one model request.
 */
export function parsePiTranscript(lines: readonly TranscriptLine[]): RequestTurn[] {
  const turns: RequestTurn[] = []
  let turn: RequestTurn | null = null
  let pendingSent: TranscriptLine[] = []
  let currentModel: string | null = null
  let currentProvider: string | null = null

  for (const line of lines) {
    const { record } = line
    const type = str(record.type)

    if (type === 'model_change') {
      const model = piModelName(record.modelId) ?? piModelName(record.model)
      if (model) currentModel = model
      const provider = piProviderName(record.provider)
      if (provider) currentProvider = provider
      continue
    }

    if (type === 'compaction' || type === 'branch_summary' || type === 'custom_message') {
      if (sentPartsOf(record).length > 0) pendingSent.push(line)
      continue
    }

    if (type !== 'message') continue
    const message = obj(record.message)
    if (!message) continue
    const role = str(message.role)

    if (role === 'user') {
      const id = nonEmpty(record.id) ?? `turn-${line.end}`
      turn = {
        id,
        index: null,
        prompt: userPromptText(message.content),
        startedAt: parseEpochMs(message.timestamp) ?? parseIsoMs(record.timestamp),
        requests: [],
      }
      turns.push(turn)
      pendingSent = [line]
      continue
    }

    if (
      role === 'toolResult' ||
      role === 'bashExecution' ||
      role === 'custom' ||
      role === 'branchSummary' ||
      role === 'compactionSummary'
    ) {
      pendingSent.push(line)
      continue
    }

    if (role !== 'assistant') continue

    const id = nonEmpty(record.id) ?? `req-${line.start}`
    const times = parsePiTimes(record.timestamp, message.timestamp, message.durationMs)
    if (!turn) {
      turn = {
        id: `before:${id}`,
        index: null,
        prompt: '',
        startedAt: times.sentAt,
        requests: [],
      }
      turns.push(turn)
    }

    const model = piModelName(message.model) ?? currentModel
    const provider = piProviderName(message.provider) ?? currentProvider
    const thinkingLevel = nonEmpty(message.thinkingLevel)
    const cost = confirmedPiCost(message.usage)
    const stop = nonEmpty(message.stopReason)
    const errorMessage = nonEmpty(message.errorMessage)
    const failed = stop === 'error' || stop === 'aborted' || errorMessage !== null
    const status = failed ? 'failed' : stop === 'pending' ? 'running' : 'done'
    const error =
      errorMessage ?? (stop === 'error' ? 'Error' : stop === 'aborted' ? 'Aborted' : null)

    const params: RequestParam[] = [
      ...(provider ? [{ name: 'provider', value: provider }] : []),
      ...(thinkingLevel ? [{ name: 'thinking', value: thinkingLevel }] : []),
      ...(cost !== null && cost > 0 ? [{ name: 'cost', value: `$${cost.toFixed(4)}` }] : []),
    ]

    const { actions, received } = receivedPartsOf(message)
    const ranges: [number, number][] = [
      ...pendingSent.map((item): [number, number] => [item.start, item.end]),
      [line.start, line.end],
    ]

    const request: ModelRequest = {
      id,
      turnId: turn.id,
      sentAt: times.sentAt,
      endedAt: times.endedAt,
      model,
      params,
      requestId: nonEmpty(message.responseId),
      stop,
      tokens: piRequestTokens(message.usage),
      actions,
      sent: pendingSent.flatMap((item) => sentPartsOf(item.record)),
      received,
      kept: null,
      added: null,
      status,
      error,
      records: ranges.length,
      raw: encodeRanges(ranges),
    }

    turn.requests.push(request)
    pendingSent = []
  }

  return turns
}

function isMessageRole(line: Buffer, role: 'assistant' | 'user'): boolean {
  const marker = role === 'assistant' ? ASSISTANT_MARKER : USER_MARKER
  if (line.indexOf(marker) < 0) return false
  try {
    const record = obj(JSON.parse(line.toString('utf8')))
    return record?.type === 'message' && obj(record.message)?.role === role
  } catch {
    return false
  }
}

/** Backward pagination rules: collect a page of assistant responses back to the opening user turn. */
function piPageRules(): PageRules {
  let requests = 0
  return {
    add(line) {
      if (isMessageRole(line, 'assistant')) requests++
    },
    enough: () => requests >= REQUESTS_PAGE,
    turnStart: (line) => isMessageRole(line, 'user'),
    requestEnd: (line) => isMessageRole(line, 'assistant'),
  }
}

function extractSystemBlocks(message: Rec): RequestsSystemBlock[] {
  const blocks: RequestsSystemBlock[] = []
  const sections = obj(message.sections)
  if (sections) {
    for (const value of Object.values(sections)) {
      if (typeof value !== 'string' || value.trim() === '') continue
      blocks.push({ preview: preview(value), chars: value.length })
    }
  }
  if (blocks.length === 0) {
    const content = str(message.content)
    if (content && content.trim() !== '') {
      blocks.push({ preview: preview(content), chars: content.length })
    }
  }
  return blocks
}

function extractToolNames(message: Rec): string[] {
  const names: string[] = []
  for (const item of arr(message.toolsAdded)) {
    const name = nonEmpty(obj(item)?.name)
    if (name) names.push(name)
  }
  return names
}

function summarizeSystem(
  entries: readonly { at: number | null; message: Rec }[],
): RequestsSystem | null {
  if (entries.length === 0) return null
  let blocks: RequestsSystemBlock[] = []
  const activeTools = new Set<string>()
  const changes: RequestsToolChange[] = []

  entries.forEach((entry, index) => {
    const nextBlocks = extractSystemBlocks(entry.message)
    if (nextBlocks.length > 0) blocks = nextBlocks
    const names = extractToolNames(entry.message)
    const added: string[] = []
    for (const name of names) {
      if (!activeTools.has(name)) {
        activeTools.add(name)
        added.push(name)
      }
    }
    if (index > 0 && added.length > 0) {
      changes.push({ at: entry.at, added, removed: [] })
    }
  })

  if (blocks.length === 0 && activeTools.size === 0) return null

  const grouped = new Map<string, string[]>()
  for (const name of activeTools) {
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
    const group = mcp ? mcp[1]! : 'builtin'
    const list = grouped.get(group) ?? []
    list.push(mcp ? mcp[2]! : name)
    grouped.set(group, list)
  }
  const groups: RequestsToolGroup[] = [...grouped].map(([name, tools]) => ({
    kind: name === 'builtin' ? 'builtin' : 'mcp',
    name,
    tools,
  }))
  groups.sort((a, b) =>
    a.name === 'builtin' ? -1 : b.name === 'builtin' ? 1 : a.name.localeCompare(b.name),
  )

  return {
    kind: 'system',
    blocks,
    groups,
    toolCount: activeTools.size,
    changes,
  }
}

/** Summarizes the entire Pi session file: request count, tokens, confirmed cost, turns and system. */
export async function summarizePiFile(file: string): Promise<ModelRequestsOverview> {
  const log = await openLog(file)
  let requests = 0
  let tokens: RequestTokens | null = null
  let costUsd: number | null = null
  const turns: Record<string, number> = {}
  let turnNumber = 0
  const systems: { at: number | null; message: Rec }[] = []

  await eachLine(log.source, 0, (text, end) => {
    const maybeMessage =
      text.includes('"assistant"') || text.includes('"user"') || text.includes('"system"')
    if (!maybeMessage) return
    let record: Rec | null
    try {
      record = obj(JSON.parse(text))
    } catch {
      return
    }
    if (!record || record.type !== 'message') return
    const message = obj(record.message)
    if (!message) return

    if (message.role === 'user') {
      const id = nonEmpty(record.id) ?? `turn-${end - 1}`
      turnNumber++
      turns[id] = turnNumber
    } else if (message.role === 'assistant') {
      requests++
      tokens = addTokens(tokens, piRequestTokens(message.usage))
      const spent = confirmedPiCost(message.usage)
      if (spent !== null) costUsd = (costUsd ?? 0) + spent
    } else if (message.role === 'system') {
      systems.push({
        at: parseIsoMs(record.timestamp) ?? parseEpochMs(message.timestamp),
        message,
      })
    }
  })

  return {
    source: 'pi',
    requests,
    costUsd,
    tokens,
    system: summarizeSystem(systems),
    turns: turnNumber > 0 ? turns : null,
  }
}

async function systemRecords(file: string): Promise<unknown[]> {
  const log = await openLog(file)
  const records: unknown[] = []
  await eachLine(
    log.source,
    0,
    (text) => {
      if (!text.includes('"system"')) return
      try {
        const record = obj(JSON.parse(text))
        if (record?.type === 'message' && obj(record.message)?.role === 'system') {
          records.push(record)
        }
      } catch {
        // Ignore an incomplete line being written.
      }
    },
    { contains: '"system"' },
  )
  return records
}

export function piModelRequests(deps: {
  platform: Platform
  home: string
  env(agentId: AgentId): Promise<Env>
}): ModelRequestsReader {
  const found = new Map<string, string>()
  const summaries = new Map<
    string,
    { size: number; mtimeMs: number; summary: ModelRequestsOverview }
  >()

  const fileOf = async (target: RequestsTarget): Promise<string | null> => {
    if (harnessOf(target.agentId) !== 'pi') return null
    const cacheKey = `${target.agentId}\0${target.configDir ?? ''}\0${target.acpSessionId}`
    const known = found.get(cacheKey)
    if (known && (await stat(known).catch(() => null))?.isFile()) return known
    const env = await deps.env(target.agentId)
    const folders = await piFolders(env, deps.platform, deps.home, target.configDir)
    const realCwd = target.cwd ? await realpath(target.cwd).catch(() => target.cwd) : null
    const file = await findSessionFile(folders, realCwd, target.acpSessionId)
    if (!file) return null
    found.delete(cacheKey)
    found.set(cacheKey, file)
    if (found.size > REMEMBERED) found.delete(found.keys().next().value!)
    return file
  }

  return {
    async page(target, before) {
      const file = await fileOf(target)
      if (!file) return null
      const { size } = await stat(file)
      const end = before === null ? size : Math.min(size, Number(before))
      if (!Number.isSafeInteger(end) || end < 0) throw new Error('Not a page of this session')
      const { lines, from } = await readPageFrom(fileSource(file, size), end, piPageRules())
      const turns = parsePiTranscript(parseLines(lines))
      return { source: 'pi', turns, before: from > 0 ? String(from) : null }
    },

    async summary(target) {
      const file = await fileOf(target)
      if (!file) return null
      const info = await stat(file)
      const known = summaries.get(file)
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.summary
      const summary = await summarizePiFile(file)
      summaries.delete(file)
      summaries.set(file, { size: info.size, mtimeMs: info.mtimeMs, summary })
      if (summaries.size > SUMMARY_CACHE) summaries.delete(summaries.keys().next().value!)
      return summary
    },

    async raw(target, raw, full) {
      const file = await fileOf(target)
      if (!file) throw new Error(t('modelRequest.noSessionFile'))
      if (raw === SYSTEM_RAW) return foldAll(await systemRecords(file), full)
      const { size } = await stat(file)
      return readRanges(fileSource(file, size), raw, full)
    },
  }
}
