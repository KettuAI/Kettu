// Reads a Claude Code session's requests from its session file, newest page first, read back
// from the end so a long session costs no more than a short one.

import { open, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import {
  REQUESTS_PAGE,
  foldLongStrings,
  type ModelRequestRaw,
  type ModelRequestsPage,
  type RequestTokens,
  type RequestsSystem,
} from '@shared/model-requests'
import { harnessOf, type AgentId } from '@shared/thread'
import { findClaudeTranscript } from '../prompt-cache'
import { projectsFolder } from '../usage/readers/claude'
import { eachLine, openLog } from '../usage/lines'
import {
  claudeTokens,
  decodeRanges,
  isPrompt,
  parseClaudeTranscript,
  shapeTime,
  summarizeShapes,
  type TranscriptLine,
} from './claude-transcript'

/** Which session file to read. */
export interface RequestsTarget {
  agentId: AgentId
  cwd: string
  acpSessionId: string
  configDir: string | null
  /** A sub-agent's parent, whose session folder keeps the sub-agent's file. */
  parentAcpSessionId: string | null
}

/** What the whole file says beyond its pages: how many requests, the cost and the tools. */
export interface FileSummary {
  requests: number | null
  costUsd: number | null
  /** Every response's tokens added up, each response once. */
  tokens: RequestTokens | null
  system: RequestsSystem | null
}

export interface ModelRequestsReader {
  /** Null when the agent keeps no session file Kettu can read. */
  page(target: RequestsTarget, before: string | null): Promise<ModelRequestsPage | null>
  summary(target: RequestsTarget): Promise<FileSummary | null>
  raw(target: RequestsTarget, raw: string, full: boolean): Promise<ModelRequestRaw>
}

const CHUNK = 1 << 18
/** How far back a page goes for the start of its first turn. */
const TURN_LIMIT = 8 << 20
/** The most Raw reads for one request, folded or not. */
const RAW_LIMIT = 64 << 20
const REMEMBERED = 200
const SUBAGENT_ID = /^[A-Za-z0-9_-]+$/
const NEWLINE = 0x0a

const REQUEST_PREFIX = Buffer.from('{"type":"api-request","')
const SHAPE_PREFIX = '{"type":"api-request-shape"'
const COST_PREFIX = '{"type":"cost-state"'
const ASSISTANT = Buffer.from('"type":"assistant"')
const USER = Buffer.from('"type":"user"')
const TOOL_RESULT = Buffer.from('"toolUseResult"')
const STOP = Buffer.from('"stop_reason":"')

const startsWith = (line: Buffer, prefix: Buffer): boolean =>
  line.length >= prefix.length && line.subarray(0, prefix.length).equals(prefix)

function promptLine(line: Buffer): boolean {
  if (line.indexOf(USER) < 0 || line.indexOf(TOOL_RESULT) >= 0) return false
  try {
    return isPrompt(JSON.parse(line.toString('utf8')) as Record<string, unknown>)
  } catch {
    return false
  }
}

interface RawLine {
  start: number
  end: number
  bytes: Buffer
}

/**
 * The lines of a page ending at `end`: at least `REQUESTS_PAGE` requests, back to the start of
 * the turn the earliest of them is in when that lies within `TURN_LIMIT`, else back to just after
 * the earliest response read, so no request is cut. `from` is where the page starts.
 */
export async function readPage(
  file: string,
  end: number,
): Promise<{ lines: RawLine[]; from: number }> {
  const handle = await open(file, 'r')
  // Newest first while reading.
  const lines: RawLine[] = []
  const page = (from: number): { lines: RawLine[]; from: number } => ({
    lines: lines.filter((line) => line.start >= from).reverse(),
    from,
  })
  try {
    let requests = 0
    let responses = 0
    let rest = Buffer.alloc(0)
    let at = end
    // Where enough requests were read, and the earliest place after a response since.
    let enoughAt: number | null = null
    let cut: number | null = null
    while (at > 0) {
      const start = Math.max(0, at - CHUNK)
      const buffer = Buffer.alloc(at - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      const data = Buffer.concat([buffer.subarray(0, bytesRead), rest])
      let stop = data.length
      for (;;) {
        const newline = data.lastIndexOf(NEWLINE, stop - 1)
        if (newline === -1 && start > 0) break
        const bytes = data.subarray(newline + 1, stop)
        const begin = start + newline + 1
        if (bytes.length > 0) {
          const assistant = bytes.indexOf(ASSISTANT) >= 0
          if (enoughAt !== null) {
            if (promptLine(bytes)) {
              lines.push({ start: begin, end: begin + bytes.length, bytes })
              return page(begin)
            }
            if (assistant) cut = begin + bytes.length + 1
            if (enoughAt - begin > TURN_LIMIT && cut !== null) return page(cut)
          }
          lines.push({ start: begin, end: begin + bytes.length, bytes })
          if (startsWith(bytes, REQUEST_PREFIX)) requests++
          else if (assistant && bytes.indexOf(STOP) >= 0) responses++
          // A response is written over several lines, so they count only in files without request
          // records, and twice over.
          if (
            enoughAt === null &&
            (requests >= REQUESTS_PAGE || (requests === 0 && responses >= REQUESTS_PAGE * 2))
          ) {
            enoughAt = begin
          }
        }
        if (newline === -1) break
        stop = newline
      }
      rest = Buffer.from(data.subarray(0, stop))
      at = start
    }
    return page(0)
  } finally {
    await handle.close()
  }
}

function parseLines(lines: RawLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const line of lines) {
    try {
      const record = JSON.parse(line.bytes.toString('utf8')) as unknown
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        out.push({ start: line.start, end: line.end, record: record as Record<string, unknown> })
      }
    } catch {
      // A line cut by a write in progress is read with the next page.
    }
  }
  return out
}

/** What the whole file holds beyond a page, reading only the lines that start as these do. */
/**
 * What the whole file holds beyond a page, reading only the lines that start as these do. In a
 * sub-agent's own file every line is a side chain, so `sidechain` counts them.
 */
export async function summarizeFile(file: string, sidechain = false): Promise<FileSummary> {
  const log = await openLog(file)
  let requests = 0
  let responses = 0
  let cost: number | null = null
  const shapes: { at: number | null; shape: Record<string, unknown> }[] = []
  const counted = new Set<string>()
  let tokens: RequestTokens | null = null
  const add = (usage: RequestTokens): void => {
    const sum = (a: number | null, b: number | null) =>
      a === null && b === null ? null : (a ?? 0) + (b ?? 0)
    tokens = tokens
      ? {
          input: sum(tokens.input, usage.input),
          cacheRead: sum(tokens.cacheRead, usage.cacheRead),
          cacheWrite: sum(tokens.cacheWrite, usage.cacheWrite),
          cacheWrite1h: sum(tokens.cacheWrite1h, usage.cacheWrite1h),
          output: sum(tokens.output, usage.output),
          reasoning: sum(tokens.reasoning, usage.reasoning),
        }
      : usage
  }
  await eachLine(log.source, 0, (text) => {
    if (text.startsWith('{"type":"api-request","')) requests++
    else if (text.startsWith(SHAPE_PREFIX) || text.startsWith(COST_PREFIX)) {
      try {
        const record = JSON.parse(text) as Record<string, unknown>
        if (record.type === 'cost-state' && typeof record.totalCostUSD === 'number') {
          cost = record.totalCostUSD
        } else if (
          record.type === 'api-request-shape' &&
          record.shape &&
          typeof record.shape === 'object'
        ) {
          shapes.push({ at: shapeTime(record), shape: record.shape as Record<string, unknown> })
        }
      } catch {
        // A line being written is left for the next read.
      }
    } else if (text.includes('"type":"assistant"')) {
      if (text.includes('"stop_reason":"')) responses++
      if (!text.includes('"usage"')) return
      try {
        const record = JSON.parse(text) as Record<string, unknown>
        const message = record.message as Record<string, unknown> | undefined
        const id = typeof message?.id === 'string' ? message.id : null
        if (!message || !id || counted.has(id)) return
        if (record.isSidechain === true && !sidechain) return
        if (message.model === '<synthetic>') return
        counted.add(id)
        add(claudeTokens(message.usage as Record<string, unknown> | null))
      } catch {
        // A line being written is left for the next read.
      }
    }
  })
  return {
    requests: requests > 0 ? requests : responses > 0 ? responses : null,
    costUsd: cost,
    tokens,
    system: summarizeShapes(shapes),
  }
}

/** The shape records of a file, oldest first, for the Raw of the system prompt and tools. */
async function shapeRecords(file: string): Promise<unknown[]> {
  const log = await openLog(file)
  const records: unknown[] = []
  await eachLine(
    log.source,
    0,
    (text) => {
      if (!text.startsWith(SHAPE_PREFIX)) return
      try {
        records.push(JSON.parse(text))
      } catch {
        // Left for the next read.
      }
    },
    { contains: SHAPE_PREFIX },
  )
  return records
}

export function claudeModelRequests(deps: {
  platform: Platform
  home: string
  env(): Promise<Record<string, string | undefined>>
}): ModelRequestsReader {
  const found = new Map<string, string>()
  const summaries = new Map<string, { size: number; mtimeMs: number; summary: FileSummary }>()

  const fileOf = async (target: RequestsTarget): Promise<string | null> => {
    if (harnessOf(target.agentId) !== 'claude-code') return null
    const key = `${target.parentAcpSessionId ?? ''}/${target.acpSessionId}`
    const known = found.get(key)
    if (known && (await stat(known).catch(() => null))?.isFile()) return known
    const root = projectsFolder(await deps.env(), deps.home, deps.platform, target.configDir)
    let file: string | null
    if (!target.parentAcpSessionId) {
      file = await findClaudeTranscript(root, target.cwd, target.acpSessionId)
    } else {
      // A sub-agent's file is in its parent's session folder, beside the parent's own file.
      const parent = await findClaudeTranscript(root, target.cwd, target.parentAcpSessionId)
      const child = SUBAGENT_ID.test(target.acpSessionId)
        ? parent &&
          path.join(
            parent.replace(/\.jsonl$/, ''),
            'subagents',
            `agent-${target.acpSessionId}.jsonl`,
          )
        : null
      file = child && (await stat(child).catch(() => null))?.isFile() ? child : null
    }
    if (!file) return null
    found.delete(key)
    found.set(key, file)
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
      const { lines, from } = await readPage(file, end)
      const parsed = parseClaudeTranscript(parseLines(lines))
      return { source: 'claude', turns: parsed.turns, before: from > 0 ? String(from) : null }
    },

    async summary(target) {
      const file = await fileOf(target)
      if (!file) return null
      const info = await stat(file)
      const known = summaries.get(file)
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.summary
      const summary = await summarizeFile(file, !!target.parentAcpSessionId)
      summaries.delete(file)
      summaries.set(file, { size: info.size, mtimeMs: info.mtimeMs, summary })
      if (summaries.size > 20) summaries.delete(summaries.keys().next().value!)
      return summary
    },

    async raw(target, raw, full) {
      const file = await fileOf(target)
      if (!file) throw new Error('This session has no session file to read')
      if (raw === 'system') {
        return foldAll(await shapeRecords(file), full)
      }
      const ranges = decodeRanges(raw)
      if (!ranges) throw new Error('Not a request of this session')
      const { size } = await stat(file)
      let total = 0
      for (const [start, end] of ranges) {
        if (end > size) throw new Error('The session file changed; open the request again')
        total += end - start
      }
      if (total > RAW_LIMIT) throw new Error('These records are too large to show')
      const handle = await open(file, 'r')
      try {
        const records: unknown[] = []
        for (const [start, end] of ranges) {
          const buffer = Buffer.alloc(end - start)
          await handle.read(buffer, 0, buffer.length, start)
          records.push(JSON.parse(buffer.toString('utf8')))
        }
        return foldAll(records, full)
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error('The session file changed; open the request again', { cause: error })
        }
        throw error
      } finally {
        await handle.close()
      }
    },
  }
}

function foldAll(records: unknown[], full: boolean): ModelRequestRaw {
  if (full) return { records, folded: false }
  const { value, folded } = foldLongStrings(records)
  return { records: value as unknown[], folded }
}
