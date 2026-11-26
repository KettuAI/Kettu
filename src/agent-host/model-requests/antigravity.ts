// 读取 Antigravity (agy) 会话的逐次模型请求记录。
// agy 将每轮用户输入、工具结果与每次模型调用 (`PLANNER_RESPONSE`) 实时写入
// `~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl`
// （并在同目录保存未截断的 `transcript_full.jsonl`）。
// 本模块复用通用分页器按页倒序读取，提供持久化、逐次请求级别的 Requests 窗格数据。

import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
} from '@shared/model-requests'
import { agyFullTranscriptFile, agyTranscriptFile } from '../acp/agy-metrics'
import {
  decodeAgyGenMetadata,
  decodeAgyStepMetadata,
  resolveAgyModelName,
  type AgyProtoRetryInfo,
} from '../acp/agy-proto'
import { withAgySqliteReadOnly } from '../acp/agy-sqlite'
import {
  agyConversationDbFile,
  DEFAULT_AGY_APP_DATA_DIR,
  resolveAgyAppDataDir,
} from '../acp/agy-store'
import { t } from '../i18n'
import { eachLine, fileSource, openLog } from '../usage/lines'
import { withoutKettu } from './acp-messages'
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
  type TranscriptLine,
} from './claude-transcript'
import { parseLines, readPageFrom, type PageRules } from './pages'
import { foldAll, readRanges, type ModelRequestsReader, type RequestsTarget } from './reader'

type Rec = Record<string, unknown>

const PLANNER_MARKER = Buffer.from('"PLANNER_RESPONSE"')
const CHECKPOINT_MARKER = Buffer.from('"CHECKPOINT"')
const USER_INPUT_MARKER = Buffer.from('"USER_INPUT"')
const PLANNER_TEXT = '"PLANNER_RESPONSE"'
const CHECKPOINT_TEXT = '"CHECKPOINT"'
const USER_INPUT_TEXT = '"USER_INPUT"'

/** agy 内置工具按操作类型的归类映射，其余工具归为普通 tool。 */
const TOOL_KINDS: Readonly<Record<string, RequestActionKind>> = {
  read_file: 'read',
  view_file: 'read',
  view_file_outline: 'read',
  view_code_item: 'read',
  list_dir: 'read',
  find_by_name: 'search',
  grep_search: 'search',
  code_search: 'search',
  edit_file: 'edit',
  write_file: 'edit',
  write_to_file: 'edit',
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  run_command: 'run',
  command_status: 'run',
  send_command_input: 'run',
  search_web: 'web',
  read_url_content: 'web',
  invoke_subagent: 'agent',
  manage_subagents: 'agent',
  send_message: 'agent',
  swarm: 'agent',
}

/** 去除 agy 在 USER_INPUT 外层包裹的 XML 提示标签与 Kettu 注入标签，还原用户原始消息。 */
export function cleanAgyUserPrompt(raw: string): string {
  const withoutMeta = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, ' ')
    .replace(/<\/?USER_REQUEST>/g, ' ')
  return withoutKettu(withoutMeta)
}

/** 将 agy 工具名称映射为可读动作标签（剥离 `mcp_<server>_` 前缀）。 */
function toolAction(name: string): { kind: RequestActionKind; label: string; tool: string } {
  const mcp = /^mcp_[^_]+_(.+)$/.exec(name)
  const label = mcp ? mcp[1]! : name
  return {
    kind: TOOL_KINDS[name] ?? 'tool',
    label,
    tool: label,
  }
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

function plannerTokens(record: Rec): RequestTokens {
  const input = num(record.input_tokens)
  const cacheRead = num(record.cache_read_tokens)
  const cacheWrite = num(record.cache_write_tokens) ?? num(record.cache_creation_tokens)
  const output = num(record.output_tokens)
  const reasoning = num(record.thinking_tokens)
  return {
    input,
    cacheRead,
    cacheWrite,
    cacheWrite1h: null,
    output,
    reasoning,
  }
}

function addTokens(sum: RequestTokens | null, next: RequestTokens): RequestTokens | null {
  if (
    next.input === null &&
    next.cacheRead === null &&
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

/** 将在一次 PLANNER_RESPONSE 之前送入模型的记录转为 RequestPart 列表。 */
function sentPartsOf(record: Rec): RequestPart[] {
  const type = str(record.type)
  const content = str(record.content) ?? ''
  if (type === 'USER_INPUT') {
    const parts: RequestPart[] = []
    const cleaned = cleanAgyUserPrompt(content)
    if (cleaned !== '' || content !== '') {
      parts.push({
        kind: 'prompt',
        label: 'Prompt',
        preview: preview(cleaned || content),
        bytes: utf8Length(content),
      })
    }
    for (const item of arr(record.media)) {
      const media = obj(item)
      const uri = str(media?.uri)
      const mime = str(media?.mime_type)
      parts.push({
        kind: 'attachment',
        label: uri ? path.basename(uri) : (mime ?? 'Attachment'),
        preview: mime ?? '',
        bytes: null,
      })
    }
    return parts
  }
  if (type === 'GENERIC') {
    const error = str(record.error)
    const isError = record.status === 'ERROR' || error !== null
    const text = error ?? content
    return [
      {
        kind: 'tool-result',
        label: 'Tool result',
        preview: preview(text),
        bytes: utf8Length(content || text),
        ...(isError ? { error: true } : {}),
      },
    ]
  }
  if (type === 'SYSTEM_MESSAGE') {
    return [
      {
        kind: 'attachment',
        label: 'System',
        preview: preview(content),
        bytes: utf8Length(content),
      },
    ]
  }
  return []
}

/** 将一条 PLANNER_RESPONSE 转为动作摘要与收到部分列表。 */
function receivedPartsOf(record: Rec): {
  actions: ModelRequest['actions']
  received: RequestPart[]
} {
  const seen: { kind: RequestActionKind; label: string; tool?: string }[] = []
  const received: RequestPart[] = []
  const thinking = str(record.thinking)
  if (thinking) {
    seen.push({ kind: 'thinking', label: 'Thinking' })
    received.push({
      kind: 'thinking',
      label: 'Thinking',
      preview: preview(thinking),
      bytes: utf8Length(thinking),
    })
  }
  for (const item of arr(record.tool_calls)) {
    const call = obj(item)
    if (!call) continue
    const name = str(call.name) ?? 'tool'
    const args = formatArgs(call.args)
    seen.push(toolAction(name))
    received.push({
      kind: 'tool-call',
      label: name,
      preview: preview(args),
      bytes: args ? utf8Length(args) : null,
    })
  }
  const content = str(record.content)
  if (content) {
    seen.push({ kind: 'reply', label: 'Reply' })
    received.push({
      kind: 'text',
      label: 'Reply',
      preview: preview(content),
      bytes: utf8Length(content),
    })
  }
  return { actions: summarizeActions(seen), received }
}

/** 将解析后的 transcript 行（按文件正序）分组为 RequestTurn 列表。 */
export function parseAgyTranscript(lines: readonly TranscriptLine[]): RequestTurn[] {
  const turns: RequestTurn[] = []
  let turn: RequestTurn | null = null
  let pendingSent: TranscriptLine[] = []
  let previousRequest: ModelRequest | null = null

  for (const line of lines) {
    const { record } = line
    const type = str(record.type)
    const stepIndex = num(record.step_index)

    if (type === 'USER_INPUT') {
      const content = str(record.content) ?? ''
      turn = {
        id: stepIndex !== null ? `turn-${stepIndex}` : `turn-${line.start}`,
        index: null,
        prompt: preview(cleanAgyUserPrompt(content)),
        startedAt: time(record.created_at),
        requests: [],
      }
      turns.push(turn)
      pendingSent = [line]
      previousRequest = null
      continue
    }

    if (type === 'GENERIC' || type === 'SYSTEM_MESSAGE') {
      // 同轮紧随上一条 PLANNER_RESPONSE 的首个工具步骤时间可视为上一次模型生成的结束时刻。
      if (type === 'GENERIC' && previousRequest && previousRequest.endedAt === null) {
        const at = time(record.created_at)
        if (at !== null && (previousRequest.sentAt === null || at >= previousRequest.sentAt)) {
          previousRequest.endedAt = at
        }
      }
      pendingSent.push(line)
      continue
    }

    if (type !== 'PLANNER_RESPONSE' && type !== 'CHECKPOINT') continue

    const isCompaction = type === 'CHECKPOINT'
    const tokens = plannerTokens(record)
    if (
      isCompaction &&
      tokens.input === null &&
      tokens.cacheRead === null &&
      tokens.output === null
    ) {
      continue
    }

    if (!turn) {
      turn = {
        id: stepIndex !== null ? `turn-before-${stepIndex}` : `turn-${line.start}`,
        index: null,
        prompt: '',
        startedAt: time(record.created_at),
        requests: [],
      }
      turns.push(turn)
    }

    const { actions, received } = receivedPartsOf(record)
    const ranges: [number, number][] = [
      ...pendingSent.map((item): [number, number] => [item.start, item.end]),
      [line.start, line.end],
    ]
    const error = str(record.error)
    const status = record.status === 'ERROR' || error !== null ? 'failed' : 'done'
    const params: RequestParam[] = isCompaction ? [{ name: 'type', value: 'compaction' }] : []
    const request: ModelRequest = {
      id: stepIndex !== null ? `step-${stepIndex}` : `req-${line.start}`,
      turnId: turn.id,
      sentAt: time(record.created_at),
      endedAt: null,
      model: str(record.model),
      params,
      requestId: null,
      stop: null,
      tokens,
      actions: isCompaction ? [{ kind: 'tool', label: 'Compaction', count: 1 }] : actions,
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
    previousRequest = request
  }

  // 对缺失模型名的自动压缩步骤，沿同页相邻请求回退推断模型。
  const flat = turns.flatMap((item) => item.requests)
  for (let i = 0; i < flat.length; i++) {
    if (flat[i]!.model) continue
    for (let prev = i - 1; prev >= 0; prev--) {
      if (flat[prev]!.model) {
        flat[i]!.model = flat[prev]!.model
        break
      }
    }
    if (flat[i]!.model) continue
    for (let next = i + 1; next < flat.length; next++) {
      if (flat[next]!.model) {
        flat[i]!.model = flat[next]!.model
        break
      }
    }
  }

  return turns
}

/** 分页倒序规则：凑够一页 PLANNER_RESPONSE / CHECKPOINT，并回溯到首条请求所属的 USER_INPUT。 */
function agyPageRules(): PageRules {
  let requests = 0
  const isModelLine = (line: Buffer): boolean =>
    line.indexOf(PLANNER_MARKER) >= 0 || line.indexOf(CHECKPOINT_MARKER) >= 0
  return {
    add(line) {
      if (isModelLine(line)) requests++
    },
    enough: () => requests >= REQUESTS_PAGE,
    turnStart: (line) => line.indexOf(USER_INPUT_MARKER) >= 0,
    requestEnd: isModelLine,
  }
}

/** 扫描整个 transcript.jsonl 统计总请求数、累计 tokens 及各轮序号。 */
async function summarizeAgyFile(file: string): Promise<ModelRequestsOverview> {
  const log = await openLog(file)
  let requests = 0
  let tokens: RequestTokens | null = null
  const turns: Record<string, number> = {}
  let turnNumber = 0

  await eachLine(log.source, 0, (text) => {
    const isModel = text.includes(PLANNER_TEXT) || text.includes(CHECKPOINT_TEXT)
    const isUser = !isModel && text.includes(USER_INPUT_TEXT)
    if (!isModel && !isUser) return
    let record: Rec
    try {
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      record = parsed as Rec
    } catch {
      return
    }
    if (record.type === 'USER_INPUT') {
      const stepIndex = num(record.step_index)
      turnNumber++
      if (stepIndex !== null) turns[`turn-${stepIndex}`] = turnNumber
    } else if (record.type === 'PLANNER_RESPONSE' || record.type === 'CHECKPOINT') {
      const nextTokens = plannerTokens(record)
      if (
        record.type === 'CHECKPOINT' &&
        nextTokens.input === null &&
        nextTokens.cacheRead === null &&
        nextTokens.output === null
      ) {
        return
      }
      requests++
      tokens = addTokens(tokens, nextTokens)
    }
  })

  return {
    source: 'antigravity',
    requests,
    costUsd: null,
    tokens,
    system: null,
    turns: turnNumber > 0 ? turns : null,
  }
}

function formatSeconds(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 1000).toFixed(2)}s`
}

function summarizeRetries(retries: readonly AgyProtoRetryInfo[]): string | null {
  // 仅有一条不含错误码/错误信息/退避延迟的记录属于正常首调，不计作异常重试。
  const anomalous = retries.filter(
    (item) => item.error !== null || item.reasonCode !== null || (item.delayMs ?? 0) > 0,
  )
  const count = retries.length > 1 ? retries.length - 1 : anomalous.length
  if (count <= 0) return null
  const codes = [
    ...new Set(
      anomalous
        .map((item) => item.reasonCode)
        .filter((code): code is number => typeof code === 'number' && code > 0),
    ),
  ]
  const delayMs = anomalous.reduce((sum, item) => sum + (item.delayMs ?? 0), 0)
  const parts = [`${count}`]
  if (codes.length > 0) parts.push(`code ${codes.join('/')}`)
  if (delayMs > 0) parts.push(`+${formatSeconds(delayMs)}`)
  return parts.join(' · ')
}

/** 从本地 `conversations/<sessionId>.db` 补齐单页请求的思考 token、原生耗时、请求 ID 与内部重试诊断。 */
async function enrichTurnsFromDb(
  turns: RequestTurn[],
  sessionId: string,
  baseHome: string,
  appDataDir: string,
): Promise<void> {
  const dbFile = agyConversationDbFile(sessionId, baseHome, appDataDir)
  if (!dbFile) return

  const byStep = new Map<number, ModelRequest>()
  for (const turn of turns) {
    for (const req of turn.requests) {
      const m = /^step-(\d+)$/.exec(req.id)
      if (m?.[1]) byStep.set(Number(m[1]), req)
    }
  }
  if (byStep.size === 0) return

  try {
    await withAgySqliteReadOnly(dbFile, (db) => {
      const stepIds = [...byStep.keys()]
      const placeholders = stepIds.map(() => '?').join(', ')
      const rows = db
        .prepare(`SELECT idx, metadata FROM steps WHERE idx IN (${placeholders})`)
        .all(...stepIds) as { idx?: unknown; metadata?: unknown }[]

      const stepMetas = new Map<number, ReturnType<typeof decodeAgyStepMetadata>>()
      const genIds = new Set<number>()
      for (const row of rows) {
        const idx = typeof row.idx === 'number' ? row.idx : Number(row.idx)
        if (!Number.isFinite(idx) || !row.metadata) continue
        const meta = decodeAgyStepMetadata(row.metadata, idx)
        stepMetas.set(idx, meta)
        if (meta.genMetadataIdx !== null) genIds.add(meta.genMetadataIdx)
      }

      const genMetas = new Map<number, ReturnType<typeof decodeAgyGenMetadata>>()
      if (genIds.size > 0) {
        try {
          const ids = [...genIds]
          const gRows = db
            .prepare(
              `SELECT idx, data FROM gen_metadata WHERE idx IN (${ids.map(() => '?').join(', ')})`,
            )
            .all(...ids) as { idx?: unknown; data?: unknown }[]
          for (const gRow of gRows) {
            const idx = typeof gRow.idx === 'number' ? gRow.idx : Number(gRow.idx)
            if (!Number.isFinite(idx) || !gRow.data) continue
            genMetas.set(idx, decodeAgyGenMetadata(gRow.data, { includeContext: false }))
          }
        } catch {
          // 忽略缺少 gen_metadata 表的旧库。
        }
      }

      for (const [idx, req] of byStep) {
        const meta = stepMetas.get(idx)
        if (!meta) continue
        const gen =
          meta.genMetadataIdx !== null ? (genMetas.get(meta.genMetadataIdx) ?? null) : null
        const thinking =
          meta.modelUsage?.thinkingOutputTokens ?? gen?.usage?.thinkingOutputTokens ?? null
        if (thinking !== null && req.tokens.reasoning === null) {
          req.tokens = { ...req.tokens, reasoning: thinking }
        }
        const requestId = meta.modelUsage?.requestId ?? gen?.usage?.requestId ?? null
        if (requestId && !req.requestId) req.requestId = requestId

        const ended = meta.finishedGeneratingAtMs ?? meta.completedAtMs
        if (ended !== null && (req.sentAt === null || ended >= req.sentAt)) {
          req.endedAt = ended
        }

        if (!req.model) {
          req.model = resolveAgyModelName({
            responseModel: gen?.responseModel,
            model: meta.modelUsage?.model ?? meta.generatorModel ?? gen?.model,
            extraModelEnum: gen?.extraMeta.model_enum,
            displayName: gen?.modelDisplayName,
          })
        }

        if (gen?.ttftMs !== null && gen?.ttftMs !== undefined && gen.ttftMs > 0) {
          req.params.push({ name: 'TTFT', value: formatSeconds(gen.ttftMs) })
        }
        if (
          gen?.streamingDurationMs !== null &&
          gen?.streamingDurationMs !== undefined &&
          gen.streamingDurationMs > 0
        ) {
          req.params.push({ name: 'Stream', value: formatSeconds(gen.streamingDurationMs) })
        }
        const retries = meta.retries.length > 0 ? meta.retries : (gen?.retries ?? [])
        const retryText = summarizeRetries(retries)
        if (retryText) req.params.push({ name: 'Retries', value: retryText })
      }
    })
  } catch {
    // 轨迹库不可读时静默保留 transcript.jsonl 已有数据。
  }
}

/** 扫描本地轨迹库累计全会话思考 token，补齐 Requests 顶部总览。 */
async function sumReasoningFromDb(
  sessionId: string,
  baseHome: string,
  appDataDir: string,
): Promise<number | null> {
  const dbFile = agyConversationDbFile(sessionId, baseHome, appDataDir)
  if (!dbFile) return null
  const normCid = sessionId.toLowerCase()
  try {
    return await withAgySqliteReadOnly(dbFile, (db) => {
      const rows = db
        .prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL')
        .all() as { idx?: unknown; metadata?: unknown }[]
      let total = 0
      let found = false
      for (const row of rows) {
        const idx = typeof row.idx === 'number' ? row.idx : Number(row.idx)
        if (!Number.isFinite(idx) || !row.metadata) continue
        const meta = decodeAgyStepMetadata(row.metadata, idx)
        if (meta.originCascadeId && meta.originCascadeId !== normCid) continue
        const thinking = meta.modelUsage?.thinkingOutputTokens
        if (typeof thinking === 'number' && thinking > 0) {
          total += thinking
          found = true
        }
      }
      return found ? total : null
    })
  } catch {
    return null
  }
}

/** 当用户请求展开完整 Raw 且存在 transcript_full.jsonl 时，用未截断的记录替换被截断的步骤。 */
async function hydrateFullRecords(records: unknown[], fullFile: string | null): Promise<unknown[]> {
  if (!fullFile) return records
  const needed = new Set<number>()
  for (const item of records) {
    const rec = obj(item)
    const stepIndex = num(rec?.step_index)
    if (stepIndex !== null && arr(rec?.truncated_fields).length > 0) needed.add(stepIndex)
  }
  if (needed.size === 0) return records
  if (!(await stat(fullFile).catch(() => null))?.isFile()) return records

  const byStep = new Map<number, unknown>()
  const log = await openLog(fullFile)
  await eachLine(log.source, 0, (text) => {
    if (byStep.size === needed.size) return
    let parsed: Rec
    try {
      const value = JSON.parse(text) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      parsed = value as Rec
    } catch {
      return
    }
    const stepIndex = num(parsed.step_index)
    if (stepIndex !== null && needed.has(stepIndex)) byStep.set(stepIndex, parsed)
  })

  return records.map((item) => {
    const stepIndex = num(obj(item)?.step_index)
    return stepIndex !== null && byStep.has(stepIndex) ? byStep.get(stepIndex)! : item
  })
}

/**
 * Antigravity 的 Requests 窗格读取器：
 * 优先读取磁盘上的 `transcript.jsonl`（按逐次模型调用展示且重启持久保留）；
 * 在文件尚未生成前可无缝回退到内存中的 ACP 读取器。
 */
export function antigravityModelRequests(deps: {
  home?: string
  fallback?: ModelRequestsReader
}): ModelRequestsReader {
  const summaries = new Map<
    string,
    { size: number; mtimeMs: number; summary: ModelRequestsOverview }
  >()
  // An added agent's session was started in its own folder, which agy takes for its home.
  const home = (target: RequestsTarget) => target.configDir ?? deps.home ?? os.homedir()

  const resolveFile = async (
    target: RequestsTarget,
  ): Promise<{ file: string; appDataDir: string } | null> => {
    const baseHome = home(target)
    const defaultFile = agyTranscriptFile(target.acpSessionId, baseHome, DEFAULT_AGY_APP_DATA_DIR)
    if (defaultFile && (await stat(defaultFile).catch(() => null))?.isFile()) {
      return { file: defaultFile, appDataDir: DEFAULT_AGY_APP_DATA_DIR }
    }
    const appDataDir = await resolveAgyAppDataDir(target.acpSessionId, baseHome)
    if (!appDataDir || appDataDir === DEFAULT_AGY_APP_DATA_DIR) return null
    const altFile = agyTranscriptFile(target.acpSessionId, baseHome, appDataDir)
    if (altFile && (await stat(altFile).catch(() => null))?.isFile()) {
      return { file: altFile, appDataDir }
    }
    return null
  }

  return {
    async page(target, before) {
      const resolved = await resolveFile(target)
      if (!resolved) return deps.fallback ? deps.fallback.page(target, before) : null
      const { file, appDataDir } = resolved
      const { size } = await stat(file)
      const end = before === null ? size : Math.min(size, Number(before))
      if (!Number.isSafeInteger(end) || end < 0) throw new Error('Not a page of this session')
      const { lines, from } = await readPageFrom(fileSource(file, size), end, agyPageRules())
      const turns = parseAgyTranscript(parseLines(lines))
      await enrichTurnsFromDb(turns, target.acpSessionId, home(target), appDataDir)
      return {
        source: 'antigravity',
        turns,
        before: from > 0 ? String(from) : null,
      }
    },

    async summary(target) {
      const resolved = await resolveFile(target)
      if (!resolved) return deps.fallback ? deps.fallback.summary(target) : null
      const { file, appDataDir } = resolved
      const info = await stat(file)
      const known = summaries.get(file)
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.summary
      const summary = await summarizeAgyFile(file)
      if (summary.tokens && summary.tokens.reasoning === null) {
        const reasoning = await sumReasoningFromDb(target.acpSessionId, home(target), appDataDir)
        if (reasoning !== null) summary.tokens = { ...summary.tokens, reasoning }
      }
      summaries.delete(file)
      summaries.set(file, { size: info.size, mtimeMs: info.mtimeMs, summary })
      if (summaries.size > 20) summaries.delete(summaries.keys().next().value!)
      return summary
    },

    async raw(target, raw, full) {
      // ACP fallback raw handles use `start-end` (without colon); transcript byte ranges use `start:end`.
      if (!raw.includes(':') && deps.fallback) return deps.fallback.raw(target, raw, full)
      const resolved = await resolveFile(target)
      if (!resolved) throw new Error(t('modelRequest.noSessionFile'))
      const { file, appDataDir } = resolved
      const { size } = await stat(file)
      if (!full) return readRanges(fileSource(file, size), raw, false)
      const result = await readRanges(fileSource(file, size), raw, true)
      const fullFile = agyFullTranscriptFile(target.acpSessionId, home(target), appDataDir)
      const hydrated = await hydrateFullRecords(result.records, fullFile)
      return foldAll(hydrated, true)
    },
  }
}
