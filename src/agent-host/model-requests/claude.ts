// Reads a Claude Code session's requests from its session file, newest page first, read back
// from the end so a long session costs no more than a short one.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import {
  REQUESTS_PAGE,
  type ModelRequestsOverview,
  type RequestTokens,
  type RequestsSystem,
} from '@shared/model-requests'
import { harnessOf } from '@shared/thread'
import { findClaudeTranscript } from '../prompt-cache'
import { projectsFolder } from '../usage/readers/claude'
import { t } from '../i18n'
import { eachLine, fileSource, openLog } from '../usage/lines'
import { parseLines, readPageFrom, type PageRules, type RawLine } from './pages'
import { foldAll, readRanges, type ModelRequestsReader, type RequestsTarget } from './reader'
import {
  claudeTokens,
  isPrompt,
  parseClaudeTranscript,
  shapeTime,
  summarizeShapes,
} from './claude-transcript'

/** What the whole file says beyond its pages: how many requests, the cost and the tools. */
export interface FileSummary {
  requests: number | null
  costUsd: number | null
  /** Every response's tokens added up, each response once. */
  tokens: RequestTokens | null
  system: RequestsSystem | null
}

const REMEMBERED = 200
const SUBAGENT_ID = /^[A-Za-z0-9_-]+$/

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

/** Claude Code's page: its `api-request` records, or in older files its responses. */
function claudeRules(): PageRules {
  let requests = 0
  let responses = 0
  return {
    add(line) {
      if (startsWith(line, REQUEST_PREFIX)) requests++
      else if (line.indexOf(ASSISTANT) >= 0 && line.indexOf(STOP) >= 0) responses++
    },
    // A response is written over several lines, so they count only in files without request
    // records, and twice over.
    enough: () => requests >= REQUESTS_PAGE || (requests === 0 && responses >= REQUESTS_PAGE * 2),
    turnStart: promptLine,
    requestEnd: (line) => line.indexOf(ASSISTANT) >= 0,
  }
}

/** The lines of the page of a Claude Code session file that ends at `end`. */
export async function readPage(
  file: string,
  end: number,
): Promise<{ lines: RawLine[]; from: number }> {
  const { size } = await stat(file)
  return readPageFrom(fileSource(file, size), end, claudeRules())
}

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
  const summaries = new Map<
    string,
    { size: number; mtimeMs: number; summary: ModelRequestsOverview }
  >()

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
      const summary: ModelRequestsOverview = {
        source: 'claude',
        turns: null,
        ...(await summarizeFile(file, !!target.parentAcpSessionId)),
      }
      summaries.delete(file)
      summaries.set(file, { size: info.size, mtimeMs: info.mtimeMs, summary })
      if (summaries.size > 20) summaries.delete(summaries.keys().next().value!)
      return summary
    },

    async raw(target, raw, full) {
      const file = await fileOf(target)
      if (!file) throw new Error(t('modelRequest.noSessionFile'))
      if (raw === 'system') return foldAll(await shapeRecords(file), full)
      const { size } = await stat(file)
      return readRanges(fileSource(file, size), raw, full)
    },
  }
}
