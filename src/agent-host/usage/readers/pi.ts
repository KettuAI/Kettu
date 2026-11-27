// Pi's usage from its JSONL session logs: one row per assistant model response (or standalone
// usage record) with confirmed token counts, respecting PI_CODING_AGENT_DIR,
// PI_CODING_AGENT_SESSION_DIR and settings.json sessionDir.

import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { piSessionsDir, piSessionsLocation } from '../../pi/session-files'
import {
  parsePiSessionHeader,
  parsePiTimes,
  parsePiUsage,
  piModelName,
  sessionIdFromPiFile,
} from '../../pi/usage'
import { eachLine, openLog, resumeOffset, tailHash, unchanged } from '../lines'
import {
  normalizeModel,
  type FileCursor,
  type LogReader,
  type ScanContext,
  type UsageRow,
} from '../model'

const AGENT_ID = 'pi'
const STATE_VERSION = 1
/** Maximum folder depth under the sessions root (sessions/<cwd-folder>/*.jsonl plus one extra). */
const MAX_DEPTH = 3

interface PiCursorState {
  v: typeof STATE_VERSION
  sessionId: string | null
  project: string | null
  model: string | null
}

interface Pending {
  file: string
  cursor: FileCursor | null
  bytes: number
}

type Rec = Record<string, unknown>

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function asObject(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed !== '' ? trimmed : null
}

function restoreState(raw: string | null): PiCursorState | null {
  if (!raw) return null
  try {
    const parsed = asObject(JSON.parse(raw))
    if (!parsed || parsed.v !== STATE_VERSION) return null
    return {
      v: STATE_VERSION,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      project: typeof parsed.project === 'string' ? parsed.project : null,
      model: typeof parsed.model === 'string' ? parsed.model : null,
    }
  } catch {
    return null
  }
}

/** Collects every `.jsonl` session log under `root`, or null when `root` does not exist. */
async function listLogs(root: string, log: ScanContext['log']): Promise<string[] | null> {
  let rootEntries: Dirent[]
  try {
    rootEntries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }

  const files: string[] = []
  const visited = new Set<string>()
  const rootReal = await realpath(root).catch(() => path.resolve(root))
  visited.add(rootReal)

  const walk = async (dir: string, entries: Dirent[], depth: number): Promise<void> => {
    const subdirs: string[] = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.name.endsWith('.jsonl') && !entry.isDirectory()) {
        files.push(full)
        continue
      }
      if (depth >= MAX_DEPTH) continue
      if (entry.isDirectory() || entry.isSymbolicLink()) subdirs.push(full)
    }
    await Promise.all(
      subdirs.map(async (sub) => {
        let info
        try {
          info = await stat(sub)
        } catch (error) {
          if (!isMissing(error)) log('warn', `Could not check ${sub}: ${(error as Error).message}`)
          return
        }
        if (!info.isDirectory()) return
        const real = await realpath(sub).catch(() => path.resolve(sub))
        if (visited.has(real)) return
        visited.add(real)
        let children: Dirent[]
        try {
          children = await readdir(sub, { withFileTypes: true })
        } catch (error) {
          if (!isMissing(error)) log('warn', `Could not list ${sub}: ${(error as Error).message}`)
          return
        }
        await walk(sub, children, depth + 1)
      }),
    )
  }

  await walk(root, rootEntries, 0)
  return files
}

async function changedLogs(files: readonly string[], context: ScanContext): Promise<Pending[]> {
  const pending = await Promise.all(
    files.map(async (file): Promise<Pending | null> => {
      let info
      try {
        info = await stat(file, { bigint: true })
      } catch (error) {
        if (!isMissing(error)) {
          context.log('warn', `Could not check ${file}: ${(error as Error).message}`)
        }
        return null
      }
      if (!info.isFile()) return null
      const size = Number(info.size)
      const cursor = context.cursor(file)
      if (unchanged(cursor, size, info.mtimeNs)) return null
      const bytes = cursor && cursor.offset <= size ? size - cursor.offset : size
      return { file, cursor, bytes }
    }),
  )
  return pending.filter((item): item is Pending => item !== null)
}

/** Fast substring filter so huge toolResult and system lines are skipped without JSON.parse. */
function mayCarryUsageOrMeta(line: string): boolean {
  return line.includes('"usage"') || line.includes('"model_change"') || line.includes('"session"')
}

function readRecord(
  record: Rec,
  state: PiCursorState,
  file: string,
  lineEnd: number,
  fallbackAt: number,
): UsageRow | null {
  const header = parsePiSessionHeader(record)
  if (header) {
    if (header.id) state.sessionId = header.id
    state.project = header.cwd
    return null
  }

  if (record.type === 'model_change') {
    const nextModel = piModelName(record.modelId) ?? piModelName(record.model)
    if (nextModel) state.model = nextModel
    return null
  }

  if (record.type === 'message') {
    const message = asObject(record.message)
    if (!message || message.role !== 'assistant') return null
    const parsed = parsePiUsage(message.usage)
    if (!parsed || !parsed.hasTokens) return null

    const rawModel = piModelName(message.model) ?? state.model
    const times = parsePiTimes(record.timestamp, message.timestamp, message.durationMs)
    const at = times.at ?? fallbackAt
    const entryId = nonEmpty(record.id)
    // Keying by entry id + timestamp deduplicates entries copied into forked Pi session files.
    const key = entryId ? `pi:${entryId}:${at}` : `pi:line:${state.sessionId ?? file}:${lineEnd}`

    return {
      key,
      source: 'log',
      agentId: AGENT_ID,
      sessionId: state.sessionId,
      project: state.project,
      model: rawModel ? normalizeModel(rawModel) : '',
      at,
      input: parsed.input ?? 0,
      // Pi's output already includes reasoning tokens, so reasoning stays null to avoid double counting.
      output: parsed.output ?? 0,
      reasoning: null,
      cacheRead: parsed.cacheRead ?? 0,
      cacheWrite: parsed.cacheWrite ?? 0,
      cacheWrite1h: 0,
      turn: 0,
      cost: parsed.cost,
    }
  }

  if (record.type === 'usage') {
    const parsed = parsePiUsage(record.usage ?? record)
    if (!parsed || !parsed.hasTokens) return null
    const rawModel = piModelName(record.model) ?? piModelName(record.modelId) ?? state.model
    const times = parsePiTimes(record.timestamp, null, record.durationMs)
    const at = times.at ?? fallbackAt
    const entryId = nonEmpty(record.id)
    const key = entryId
      ? `pi:u:${entryId}:${at}`
      : `pi:u:line:${state.sessionId ?? file}:${lineEnd}`

    return {
      key,
      source: 'log',
      agentId: AGENT_ID,
      sessionId: state.sessionId,
      project: state.project,
      model: rawModel ? normalizeModel(rawModel) : '',
      at,
      input: parsed.input ?? 0,
      output: parsed.output ?? 0,
      reasoning: null,
      cacheRead: parsed.cacheRead ?? 0,
      cacheWrite: parsed.cacheWrite ?? 0,
      cacheWrite1h: 0,
      turn: 0,
      cost: parsed.cost,
    }
  }

  return null
}

async function readLog(
  file: string,
  cursor: FileCursor | null,
  signal: AbortSignal,
): Promise<{ rows: UsageRow[]; cursor: FileCursor }> {
  const log = await openLog(file)
  let start = await resumeOffset(log.source, cursor)
  let state = start > 0 ? restoreState(cursor?.state ?? null) : null
  if (!state) {
    start = 0
    state = {
      v: STATE_VERSION,
      sessionId: sessionIdFromPiFile(file),
      project: null,
      model: null,
    }
  }

  const fallbackAt = Number(log.mtimeNs / 1_000_000n)
  const rows: UsageRow[] = []

  const offset = await eachLine(
    log.source,
    start,
    (text, lineEnd) => {
      if (!mayCarryUsageOrMeta(text)) return
      let record: Rec | null
      try {
        record = asObject(JSON.parse(text))
      } catch {
        return
      }
      if (!record) return
      const row = readRecord(record, state, file, lineEnd, fallbackAt)
      if (row) rows.push(row)
    },
    { signal },
  )

  return {
    rows,
    cursor: {
      id: file,
      agentId: AGENT_ID,
      size: log.size,
      mtimeNs: log.mtimeNs,
      offset,
      tail: await tailHash(log.source, offset),
      state: JSON.stringify(state),
    },
  }
}

export const piReader: LogReader = {
  agentId: AGENT_ID,

  locations: (env, home) => [piSessionsLocation(env, home, process.platform)],

  async scan(context) {
    const root = await piSessionsDir(context.env, context.home, context.platform)
    const files = await listLogs(root, context.log)
    if (!files) return false
    const pending = await changedLogs(files, context)
    context.plan(
      pending.length,
      pending.reduce((sum, item) => sum + item.bytes, 0),
    )
    for (const item of pending) {
      context.signal.throwIfAborted()
      let read
      try {
        read = await readLog(item.file, item.cursor, context.signal)
      } catch (error) {
        if (context.signal.aborted) throw error
        context.log('warn', `Could not read ${item.file}: ${(error as Error).message}`)
      }
      if (read) context.commit(read.rows, read.cursor)
      context.done(item.bytes)
    }
    return true
  },
}
