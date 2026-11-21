// Reads a Codex thread's requests from its rollout, newest page first. Codex compresses older
// rollouts with zstd; such a file is inflated whole once and paged in memory.

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  REQUESTS_PAGE,
  type ModelRequestsOverview,
  type RequestTokens,
} from '@shared/model-requests'
import { arr, obj, str } from './claude-transcript'
import { t } from '../i18n'
import { bufferSource, eachLine, fileSource, zstdSource, type ByteSource } from '../usage/lines'
import { codexTokens, parseCodexRollout, summarizeCodexSystem } from './codex-rollout'
import { parseLines, readPageFrom, type PageRules } from './pages'
import { foldAll, readRanges, type ModelRequestsReader, type RequestsTarget } from './reader'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REMEMBERED = 200
const DAY = 86_400_000

/** A rollout line's own type sits in its first bytes; deeper ones are its payload's. */
const head = (line: Buffer | string): string =>
  typeof line === 'string' ? line.slice(0, 160) : line.subarray(0, 160).toString('utf8')
const isType = (line: Buffer | string, type: string) => head(line).includes(`"type":"${type}"`)

/** The day a UUIDv7 thread id was made, which names the folder Codex keeps its rollout in. */
function madeAt(threadId: string): number | null {
  const ms = Number.parseInt(threadId.replace(/-/g, '').slice(0, 12), 16)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

const pad = (n: number) => String(n).padStart(2, '0')

async function files(folder: string): Promise<string[]> {
  return readdir(folder).catch(() => [])
}

/** A thread's rollout: in the folder of the day it was made, else anywhere Codex keeps them. */
export async function findCodexRollout(home: string, threadId: string): Promise<string | null> {
  if (!UUID.test(threadId)) return null
  const id = threadId.toLowerCase()
  const match = (names: string[]) =>
    names.find((n) => n.startsWith('rollout-') && n.endsWith(`${id}.jsonl`)) ??
    names.find((n) => n.startsWith('rollout-') && n.endsWith(`${id}.jsonl.zst`))
  const sessions = path.join(home, 'sessions')
  const at = madeAt(id)
  if (at !== null) {
    // The folder follows the local day, a day either side of the UTC one.
    for (const offset of [0, -DAY, DAY]) {
      const d = new Date(at + offset)
      const folder = path.join(
        sessions,
        String(d.getFullYear()),
        pad(d.getMonth() + 1),
        pad(d.getDate()),
      )
      const name = match(await files(folder))
      if (name) return path.join(folder, name)
    }
  }
  for (const year of await files(sessions)) {
    for (const month of await files(path.join(sessions, year))) {
      for (const day of await files(path.join(sessions, year, month))) {
        const folder = path.join(sessions, year, month, day)
        const name = match(await files(folder))
        if (name) return path.join(folder, name)
      }
    }
  }
  const archived = path.join(home, 'archived_sessions')
  const name = match(await files(archived))
  return name ? path.join(archived, name) : null
}

/**
 * Codex's page: its `token_usage_record`s, or in older rollouts its `token_count` events, which
 * Codex also repeats when nothing new was used, so they count twice over.
 */
function codexRules(): PageRules {
  let records = 0
  let counts = 0
  return {
    add(line) {
      if (isType(line, 'token_usage_record')) records++
      else if (isType(line, 'token_count')) counts++
    },
    enough: () => records >= REQUESTS_PAGE || (records === 0 && counts >= REQUESTS_PAGE * 2),
    turnStart: (line) => isType(line, 'turn_context'),
    requestEnd: (line) =>
      isType(line, 'token_usage_record') || (records === 0 && isType(line, 'token_count')),
  }
}

async function inflate(file: string): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of zstdSource(file).chunks(0)) parts.push(chunk)
  return Buffer.concat(parts)
}

/** What the whole rollout holds beyond a page. */
export async function summarizeRollout(source: ByteSource): Promise<ModelRequestsOverview> {
  let requests = 0
  let counts = 0
  let lastTotal: string | null = null
  let tokens: RequestTokens | null = null
  let countTokens: RequestTokens | null = null
  let base: string | null = null
  let developer: string | null = null
  const tools: { at: number | null; namespaces: Record<string, unknown>[] }[] = []
  const turns: Record<string, number> = {}
  let turnCount = 0
  const parse = (text: string): Record<string, unknown> | null => {
    try {
      return obj(JSON.parse(text))
    } catch {
      return null
    }
  }
  await eachLine(source, 0, (text) => {
    if (isType(text, 'token_usage_record')) {
      requests++
      const p = obj(parse(text)?.payload)
      const total = obj(p?.thread_token_usage)
      if (total) tokens = codexTokens(total)
    } else if (isType(text, 'turn_context')) {
      const p = obj(parse(text)?.payload)
      const id = str(p?.turn_id)
      if (id && !(id in turns)) turns[id] = ++turnCount
      const settings = obj(obj(p?.collaboration_mode)?.settings)
      developer = str(settings?.developer_instructions) ?? developer
    } else if (isType(text, 'session_meta')) {
      const p = obj(parse(text)?.payload)
      base = str(obj(p?.base_instructions)?.text) ?? base
    } else if (isType(text, 'token_count')) {
      const info = obj(obj(parse(text)?.payload)?.info)
      const total = JSON.stringify(info?.total_token_usage ?? null)
      if (info?.last_token_usage && total !== lastTotal) {
        lastTotal = total
        counts++
        countTokens = codexTokens(obj(info.total_token_usage))
      }
    } else if (text.includes('"additional_tools"') && isType(text, 'response_item')) {
      const record = parse(text)
      const p = obj(record?.payload)
      if (p?.type === 'additional_tools') {
        const at = Date.parse(str(record?.timestamp) ?? '')
        tools.push({
          at: Number.isNaN(at) ? null : at,
          namespaces: arr(p.tools)
            .map(obj)
            .filter((t): t is Record<string, unknown> => t !== null),
        })
      }
    } else if (!base && text.includes('model.base_instructions')) {
      const p = obj(parse(text)?.payload)
      if (p?.type === 'message') {
        base = arr(p.content)
          .map((c) => str(obj(c)?.text) ?? '')
          .join(' ')
      }
    }
  })
  return {
    source: 'codex',
    requests: requests > 0 ? requests : counts > 0 ? counts : null,
    costUsd: null,
    tokens: tokens ?? countTokens,
    system: summarizeCodexSystem({ base, developer, tools }),
    turns,
  }
}

/** The records the system row's Raw shows: the instructions and the latest tools. */
async function systemRecords(source: ByteSource): Promise<unknown[]> {
  const records: unknown[] = []
  let tools: unknown = null
  await eachLine(source, 0, (text) => {
    const keep =
      isType(text, 'session_meta') ||
      (isType(text, 'response_item') &&
        (text.includes('model.base_instructions') || text.includes('"additional_tools"')))
    if (!keep) return
    try {
      const record = JSON.parse(text) as unknown
      if (text.includes('"additional_tools"')) tools = record
      else records.push(record)
    } catch {
      // Left for the next read.
    }
  })
  return tools ? [...records, tools] : records
}

export function codexModelRequests(deps: {
  home: string
  env(): Promise<Record<string, string | undefined>>
}): ModelRequestsReader {
  const found = new Map<string, string>()
  // The last inflated rollouts, by path, while their file is unchanged.
  const inflated = new Map<string, { size: number; mtimeMs: number; buffer: Buffer }>()
  const summaries = new Map<
    string,
    { size: number; mtimeMs: number; summary: ModelRequestsOverview }
  >()

  const fileOf = async (target: RequestsTarget): Promise<string | null> => {
    const known = found.get(target.acpSessionId)
    if (known && (await stat(known).catch(() => null))?.isFile()) return known
    const env = await deps.env()
    const home = target.configDir ?? (env.CODEX_HOME?.trim() || path.join(deps.home, '.codex'))
    const file = await findCodexRollout(home, target.acpSessionId)
    if (!file) return null
    found.delete(target.acpSessionId)
    found.set(target.acpSessionId, file)
    if (found.size > REMEMBERED) found.delete(found.keys().next().value!)
    return file
  }

  const sourceOf = async (file: string): Promise<ByteSource> => {
    const info = await stat(file)
    if (!file.endsWith('.zst')) return fileSource(file, info.size)
    const kept = inflated.get(file)
    if (kept && kept.size === info.size && kept.mtimeMs === info.mtimeMs)
      return bufferSource(kept.buffer)
    const buffer = await inflate(file)
    inflated.delete(file)
    inflated.set(file, { size: info.size, mtimeMs: info.mtimeMs, buffer })
    if (inflated.size > 2) inflated.delete(inflated.keys().next().value!)
    return bufferSource(buffer)
  }

  return {
    async page(target, before) {
      const file = await fileOf(target)
      if (!file) return null
      const source = await sourceOf(file)
      const size = source.length ?? 0
      const end = before === null ? size : Math.min(size, Number(before))
      if (!Number.isSafeInteger(end) || end < 0) throw new Error('Not a page of this session')
      const rules = codexRules()
      const { lines, from } = await readPageFrom(source, end, rules)
      const parsed = parseCodexRollout(parseLines(lines))
      return { source: 'codex', turns: parsed.turns, before: from > 0 ? String(from) : null }
    },

    async summary(target) {
      const file = await fileOf(target)
      if (!file) return null
      const info = await stat(file)
      const known = summaries.get(file)
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.summary
      const summary = await summarizeRollout(await sourceOf(file))
      summaries.delete(file)
      summaries.set(file, { size: info.size, mtimeMs: info.mtimeMs, summary })
      if (summaries.size > 20) summaries.delete(summaries.keys().next().value!)
      return summary
    },

    async raw(target, raw, full) {
      const file = await fileOf(target)
      if (!file) throw new Error(t('modelRequest.noRollout'))
      const source = await sourceOf(file)
      if (raw === 'system') return foldAll(await systemRecords(source), full)
      return readRanges(source, raw, full)
    },
  }
}
