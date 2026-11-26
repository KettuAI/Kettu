// Antigravity (Desktop / IDE / CLI) 本地用量日志读取器。
// 只读扫描各产品目录下的 `conversations/*.db`（SQLite + WAL）与 `conversation_summaries.db`，
// 当 `.db` 缺失或尚未就绪时安全回退读取 `brain/<id>/.system_generated/logs/transcript.jsonl`。
// 仅提取 token 数、模型、时间、会话 ID 与工作区路径，不读取对话正文。

import { existsSync, type Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import {
  decodeAgyGenMetadata,
  decodeAgyStepMetadata,
  resolveAgyModelName,
  type AgyProtoGenMetadata,
} from '../../acp/agy-proto'
import {
  isSqliteReadyForRead,
  statSqliteWithWal,
  withAgySqliteReadOnly,
  type SqliteWalStat,
} from '../../acp/agy-sqlite'
import {
  AGY_APP_DATA_DIRS,
  DEFAULT_AGY_APP_DATA_DIR,
  IDE_AGY_APP_DATA_DIR,
} from '../../acp/agy-store'
import { eachLine, openLog, resumeOffset, tailHash, unchanged } from '../lines'
import {
  normalizeModel,
  type FileCursor,
  type LogReader,
  type ScanContext,
  type UsageRow,
} from '../model'

const AGENT_ID = 'antigravity'
const SESSION_DB_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/i
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 单个 transcript.jsonl 回退文件的最大读取上限（24 MiB），避免异常大文件拖慢扫描。 */
const MAX_TRANSCRIPT_BYTES = 24 * 1024 * 1024
/** 仅解析包含 token 统计字段的 JSONL 行。 */
const TOKEN_NEEDLE = '_tokens"'

interface PendingDb {
  kind: 'db'
  file: string
  sessionId: string
  stat: SqliteWalStat
  cursor: FileCursor | null
}

interface PendingTranscript {
  kind: 'transcript'
  file: string
  sessionId: string
  bytes: number
  cursor: FileCursor | null
}

type PendingItem = PendingDb | PendingTranscript

function pathModule(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

function geminiBaseDir(env: ScanContext['env'], home: string, platform: Platform): string {
  const custom = env.ANTIGRAVITY_GEMINI_DIR?.trim()
  if (custom) return custom
  return pathModule(platform).join(home, '.gemini')
}

function productRoots(env: ScanContext['env'], home: string, platform: Platform): string[] {
  const p = pathModule(platform)
  const base = geminiBaseDir(env, home, platform)
  return AGY_APP_DATA_DIRS.map((dir) => p.join(base, dir))
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 将 `file://` 工作区 URI 解码为对应平台的本地绝对路径。 */
export function decodeWorkspaceUri(uri: string, platform: Platform): string | null {
  const trimmed = uri.trim()
  if (!trimmed) return null
  if (!/^file:\/\//i.test(trimmed)) return trimmed
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'file:') return null
    let pathname = decodeURIComponent(parsed.pathname)
    if (platform === 'win32') {
      if (parsed.host && parsed.host !== 'localhost') {
        return `\\\\${parsed.host}${pathname.replace(/\//g, '\\')}`
      }
      if (/^\/[a-zA-Z]:/.test(pathname)) pathname = pathname.slice(1)
      return pathname.replace(/\//g, '\\')
    }
    return pathname || null
  } catch {
    return null
  }
}

/** 解析 `conversation_summaries.workspace_uris` 列中的首个工作区目录。 */
export function parseWorkspaceUris(raw: unknown, platform: Platform): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const text = raw.trim()
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item !== 'string') continue
        const decoded = decodeWorkspaceUri(item, platform)
        if (decoded) return decoded
      }
      return null
    }
    if (typeof parsed === 'string') return decodeWorkspaceUri(parsed, platform)
  } catch {
    // 兼容非 JSON 的单条 URI 字符串。
  }
  return decodeWorkspaceUri(text, platform)
}

/** 扫描各产品目录的 `conversation_summaries.db`，建立会话 ID 到工作区目录的索引。 */
async function readWorkspaceMap(
  roots: readonly string[],
  platform: Platform,
  log: ScanContext['log'],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const root of roots) {
    const dbFile = path.join(root, 'conversation_summaries.db')
    try {
      await withAgySqliteReadOnly(dbFile, (db) => {
        const rows = db
          .prepare(
            `SELECT conversation_id, workspace_uris
             FROM conversation_summaries
             WHERE workspace_uris IS NOT NULL AND workspace_uris != ''`,
          )
          .all()
        for (const row of rows) {
          const id =
            typeof row.conversation_id === 'string' ? row.conversation_id.trim().toLowerCase() : ''
          if (!id || map.has(id)) continue
          const project = parseWorkspaceUris(row.workspace_uris, platform)
          if (project) map.set(id, project)
        }
      })
    } catch (error) {
      if (!isMissing(error)) {
        log('warn', `Could not read ${dbFile}: ${(error as Error).message}`)
      }
    }
  }
  return map
}

async function safeReaddir(dir: string, log: ScanContext['log']): Promise<Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return null
    log('warn', `Could not list ${dir}: ${(error as Error).message}`)
    return []
  }
}

interface ExtractedStep {
  stepIndex: number
  at: number
  model: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 从单个 Antigravity 会话 `.db` 中提取全部归属本会话的模型请求用量行。 */
async function readConversationDb(
  file: string,
  sessionId: string,
  project: string | null,
  fallbackAt: number,
): Promise<UsageRow[] | null> {
  const normCid = sessionId.toLowerCase()
  return withAgySqliteReadOnly(file, (db) => {
    const genMap = new Map<number, AgyProtoGenMetadata>()
    try {
      const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all()
      for (const row of genRows) {
        const idx = typeof row.idx === 'number' ? row.idx : Number(row.idx)
        if (!Number.isFinite(idx) || !row.data) continue
        const decoded = decodeAgyGenMetadata(row.data, { includeContext: false })
        if (decoded) genMap.set(idx, decoded)
      }
    } catch {
      // 兼容缺少 gen_metadata 表的旧库。
    }

    const stepRows = db
      .prepare(
        'SELECT idx, step_type, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC',
      )
      .all()
    const extracted: ExtractedStep[] = []
    let fallbackGenCursor = 0
    const genKeys = [...genMap.keys()].sort((a, b) => a - b)

    for (const row of stepRows) {
      const idx = typeof row.idx === 'number' ? row.idx : Number(row.idx)
      if (!Number.isFinite(idx) || !row.metadata) continue
      const meta = decodeAgyStepMetadata(row.metadata, idx)
      // 过滤从父会话分叉或旁路提问克隆过来的步骤，防止跨会话重复计费。
      if (meta.originCascadeId && meta.originCascadeId !== normCid) continue

      const usage = meta.modelUsage
      if (!usage) continue
      const input = Math.max(0, usage.inputTokens)
      const output = Math.max(0, usage.outputTokens)
      const cacheRead = Math.max(0, usage.cacheReadTokens)
      if (input === 0 && output === 0 && cacheRead === 0) continue

      let gen = meta.genMetadataIdx !== null ? genMap.get(meta.genMetadataIdx) : undefined
      if (!gen && fallbackGenCursor < genKeys.length) {
        const key = genKeys[fallbackGenCursor]!
        const candidate = genMap.get(key)
        if (
          candidate?.usage &&
          candidate.usage.inputTokens === input &&
          candidate.usage.outputTokens === output &&
          candidate.usage.cacheReadTokens === cacheRead
        ) {
          gen = candidate
          fallbackGenCursor++
        }
      }

      const rawModel = resolveAgyModelName({
        responseModel: gen?.responseModel,
        model: usage.model ?? meta.generatorModel ?? gen?.model,
        extraModelEnum: gen?.extraMeta.model_enum,
        displayName: gen?.modelDisplayName,
      })

      const at = meta.finishedGeneratingAtMs ?? meta.completedAtMs ?? meta.createdAtMs ?? fallbackAt

      extracted.push({
        stepIndex: meta.stepIndex,
        at,
        model: rawModel ? normalizeModel(rawModel) : null,
        input,
        output,
        cacheRead,
        cacheWrite: 0,
      })
    }

    return toUsageRows(extracted, normCid, project)
  })
}

function toUsageRows(
  steps: readonly ExtractedStep[],
  normCid: string,
  project: string | null,
): UsageRow[] {
  // 对省略模型名的 CHECKPOINT 压缩步，按同会话前一步（其次后一步）的模型推断归属。
  const models = steps.map((s) => s.model)
  for (let i = 0; i < models.length; i++) {
    if (models[i]) continue
    for (let prev = i - 1; prev >= 0; prev--) {
      if (models[prev]) {
        models[i] = models[prev]!
        break
      }
    }
    if (models[i]) continue
    for (let next = i + 1; next < models.length; next++) {
      if (models[next]) {
        models[i] = models[next]!
        break
      }
    }
  }

  return steps.map((step, i): UsageRow => ({
    key: `antigravity:${normCid}:${step.stepIndex}`,
    source: 'log',
    agentId: AGENT_ID,
    sessionId: normCid,
    project,
    model: models[i] ?? '',
    at: step.at,
    input: step.input,
    // Antigravity 的 outputTokens 已包含思考 token，reasoning 保持 null 以避免 rowTotal 重复计算。
    output: step.output,
    reasoning: null,
    cacheRead: step.cacheRead,
    cacheWrite: step.cacheWrite,
    cacheWrite1h: 0,
    turn: 0,
  }))
}

function nonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/** 回退读取 `transcript.jsonl`（用于加密 `.pb` 或尚未建库的会话）。 */
async function readTranscriptFallback(
  item: PendingTranscript,
  project: string | null,
  signal: AbortSignal,
): Promise<{ rows: UsageRow[]; cursor: FileCursor }> {
  const log = await openLog(item.file)
  const start = await resumeOffset(log.source, item.cursor)
  const fallbackAt = Number(log.mtimeNs / 1_000_000n)
  const extracted: ExtractedStep[] = []
  let lineIndex = 0

  const offset = await eachLine(
    log.source,
    start,
    (text) => {
      let record: Record<string, unknown>
      try {
        const parsed = JSON.parse(text) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
        record = parsed as Record<string, unknown>
      } catch {
        return
      }
      const input = nonNegInt(record.input_tokens)
      const output = nonNegInt(record.output_tokens)
      const cacheRead = nonNegInt(record.cache_read_tokens)
      const cacheWrite =
        nonNegInt(record.cache_write_tokens) || nonNegInt(record.cache_creation_tokens)
      if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return

      const stepIndex =
        typeof record.step_index === 'number' && Number.isFinite(record.step_index)
          ? Math.trunc(record.step_index)
          : lineIndex++
      const rawModel =
        typeof record.response_model === 'string' && record.response_model.trim()
          ? record.response_model.trim()
          : typeof record.model === 'string' && record.model.trim()
            ? record.model.trim()
            : null
      const atRaw =
        typeof record.created_at === 'string' ? Date.parse(record.created_at) : Number.NaN

      extracted.push({
        stepIndex,
        at: Number.isFinite(atRaw) ? atRaw : fallbackAt,
        model: rawModel ? normalizeModel(rawModel) : null,
        input,
        output,
        cacheRead,
        cacheWrite,
      })
    },
    { contains: TOKEN_NEEDLE, signal },
  )

  return {
    rows: toUsageRows(extracted, item.sessionId.toLowerCase(), project),
    cursor: {
      id: item.file,
      agentId: AGENT_ID,
      size: log.size,
      mtimeNs: log.mtimeNs,
      offset,
      tail: await tailHash(log.source, offset),
      state: null,
    },
  }
}

export const antigravityReader: LogReader = {
  agentId: AGENT_ID,

  locations(env, home) {
    const p = pathModule(process.platform)
    const roots = productRoots(env, home, process.platform)
    const existing = roots
      .map((root) => p.join(root, 'conversations'))
      .filter((dir) => existsSync(dir))
    if (existing.length > 0) return existing
    const base = geminiBaseDir(env, home, process.platform)
    return [
      p.join(base, DEFAULT_AGY_APP_DATA_DIR, 'conversations'),
      p.join(base, IDE_AGY_APP_DATA_DIR, 'conversations'),
    ]
  },

  async scan(context) {
    const roots = productRoots(context.env, context.home, context.platform)
    let foundAnyRoot = false
    const pending: PendingItem[] = []
    const readyDbSessions = new Set<string>()

    // 1. 收集各产品目录下已就绪的 conversations/*.db 文件。
    for (const root of roots) {
      const convDir = path.join(root, 'conversations')
      const entries = await safeReaddir(convDir, context.log)
      if (entries !== null) foundAnyRoot = true
      if (!entries) continue

      for (const entry of entries) {
        if (entry.isDirectory()) continue
        const match = SESSION_DB_RE.exec(entry.name)
        if (!match?.[1]) continue
        const sessionId = match[1].toLowerCase()
        const file = path.join(convDir, entry.name)
        if (!isSqliteReadyForRead(file)) continue
        readyDbSessions.add(sessionId)

        const info = await statSqliteWithWal(file)
        if (!info) continue
        const cursor = context.cursor(file)
        if (unchanged(cursor, info.size, info.mtimeNs)) continue
        pending.push({ kind: 'db', file, sessionId, stat: info, cursor })
      }
    }

    // 2. 对没有可用 `.db` 的会话，检查 brain/<id>/.system_generated/logs/transcript.jsonl 回退源。
    for (const root of roots) {
      const brainDir = path.join(root, 'brain')
      const entries = await safeReaddir(brainDir, context.log)
      if (entries !== null) foundAnyRoot = true
      if (!entries) continue

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        if (!SESSION_UUID_RE.test(entry.name)) continue
        const sessionId = entry.name.toLowerCase()
        if (readyDbSessions.has(sessionId)) continue

        const file = path.join(
          brainDir,
          entry.name,
          '.system_generated',
          'logs',
          'transcript.jsonl',
        )
        let info
        try {
          info = await stat(file, { bigint: true })
        } catch {
          continue
        }
        if (!info.isFile()) continue
        const size = Number(info.size)
        if (size <= 0 || size > MAX_TRANSCRIPT_BYTES) continue
        const cursor = context.cursor(file)
        if (unchanged(cursor, size, info.mtimeNs)) continue
        const bytes = cursor && cursor.offset <= size ? size - cursor.offset : size
        pending.push({ kind: 'transcript', file, sessionId, bytes, cursor })
      }
    }

    if (!foundAnyRoot) return false

    const totalBytes = pending.reduce(
      (sum, item) => sum + (item.kind === 'db' ? item.stat.bytes : item.bytes),
      0,
    )
    context.plan(pending.length, totalBytes)
    if (pending.length === 0) return true

    const workspaces = await readWorkspaceMap(roots, context.platform, context.log)

    for (const item of pending) {
      if (context.signal.aborted) break
      const project = workspaces.get(item.sessionId) ?? null
      const accountedBytes = item.kind === 'db' ? item.stat.bytes : item.bytes
      try {
        if (item.kind === 'db') {
          const fallbackAt = Number(item.stat.mtimeNs / 1_000_000n)
          const rows = await readConversationDb(item.file, item.sessionId, project, fallbackAt)
          if (rows !== null) {
            context.commit(rows, {
              id: item.file,
              agentId: AGENT_ID,
              size: item.stat.size,
              mtimeNs: item.stat.mtimeNs,
              offset: item.stat.size,
              tail: null,
              state: null,
            })
          }
        } else {
          const { rows, cursor } = await readTranscriptFallback(item, project, context.signal)
          if (!context.signal.aborted) context.commit(rows, cursor)
        }
      } catch (error) {
        if (!isMissing(error) && !context.signal.aborted) {
          context.log('warn', `Could not read ${item.file}: ${(error as Error).message}`)
        }
      }
      context.done(accountedBytes)
    }

    return true
  },
}
