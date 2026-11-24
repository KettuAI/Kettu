// 跟踪 Antigravity (agy) 每次模型请求的耗时与单步 token 用量。
// agy 通过 ACP 的 `usage_update` 仅上报当前上下文总量 (`used`/`size`)，而 `session/prompt`
// 返回的 `usage` 是整轮多步累计值；单次模型调用的 `input_tokens`、`cache_read_tokens` 和
// `output_tokens` 会实时写入 `~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl`。
// 本模块将 ACP 流式事件的毫秒级时间戳与 transcript.jsonl 尾部的 `PLANNER_RESPONSE` 结合，
// 为会话补齐精确的 `speed` (tok/s) 与 `lastRequest`。

import os from 'node:os'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk/unstable'
import type { LastRequest } from '@shared/model-requests'
import { addSpeedSample, latestTime, timeRequest } from '@shared/output-speed'
import type { SessionTarget } from '../connection'
import { scanBackwards } from '../prompt-cache'
import { fromAgy } from './agy-tools'

/** 仅允许合法的会话 ID 字符，避免构造 transcript 路径时发生路径穿越。 */
const SESSION_ID = /^[A-Za-z0-9_-]+$/
/** 快速过滤标记：仅解析包含 PLANNER_RESPONSE 的行。 */
const PLANNER_NEEDLE = '"PLANNER_RESPONSE"'
/** 倒序扫描 transcript.jsonl 尾部的最大字节数（1 MiB，足以覆盖单步大工具输出后的响应）。 */
const TAIL_BYTES = 1 << 20
/** agy 写盘与发 ACP usage_update 可能存在极短异步差，按此间隔最多重试读取两次。 */
const DEFAULT_RETRIES_MS = [80, 160] as const

/** transcript.jsonl 中单条 PLANNER_RESPONSE 解析出的用量数据。 */
export interface AgyStepUsage {
  stepIndex: number
  model: string | null
  createdAt: number | null
  /** 未命中缓存的新增输入 token（实测 agy 的 input_tokens 已扣除 cache_read_tokens）。 */
  input: number
  cacheRead: number
  cacheWrite: number | null
  output: number
}

/** 读取某个 agy 会话最新一条模型响应步骤的函数签名，便于单测注入。 */
export type AgyStepReader = (sessionId: string) => Promise<AgyStepUsage | null>

/** 宿主页签回调，用于获取当前会话状态并应用 patch。 */
export interface AgyMetricsHost {
  target(sessionId: string): SessionTarget | undefined
  now?: () => number
}

interface StepSnapshot {
  sentAt: number | null
  firstOutputAt: number | null
  endedAt: number
}

interface SessionState {
  /** 当前模型请求的发出时间（毫秒）。 */
  sentAt: number | null
  /** 当前模型请求首个流式输出到达时间（毫秒）。 */
  firstOutputAt: number | null
  /** 当前模型请求输出完结并开始发起首个工具调用的时间，用于剔除工具执行耗时。 */
  firstToolAt: number | null
  /** 本步尚未结束的工具调用 ID 集合。 */
  openTools: Set<string>
  /** 本步所有工具全部完成后记录的下一步模型请求发出时间。 */
  nextSentAt: number | null
  /** 已经消费过的最新 step_index，避免非模型调用触发的 usage_update 重复计数。 */
  lastStepIndex: number | null
  /** 会话开始一轮前的基线读取 Promise，避免把历史残留步骤误算作当前轮。 */
  baseline: Promise<void> | null
  /** 串行化同一会话的尾读与重试，保证顺序一致。 */
  chain: Promise<void>
  /** 取消/关闭时递增，中止在途重试。 */
  generation: number
}

/** 返回 agy 会话 transcript.jsonl 的路径；会话 ID 非法时返回 null。 */
export function agyTranscriptFile(sessionId: string, home = os.homedir()): string | null {
  if (!SESSION_ID.test(sessionId)) return null
  return path.join(
    home,
    '.gemini',
    'antigravity-cli',
    'brain',
    sessionId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  )
}

/** 返回 agy 会话未截断版本 transcript_full.jsonl 的路径；会话 ID 非法时返回 null。 */
export function agyFullTranscriptFile(sessionId: string, home = os.homedir()): string | null {
  if (!SESSION_ID.test(sessionId)) return null
  return path.join(
    home,
    '.gemini',
    'antigravity-cli',
    'brain',
    sessionId,
    '.system_generated',
    'logs',
    'transcript_full.jsonl',
  )
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseIsoTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** 从单行 JSON 中解析 PLANNER_RESPONSE 的 token 用量；非目标行或格式不合法时返回 null。 */
export function parseAgyPlannerStep(json: string): AgyStepUsage | null {
  if (!json.includes(PLANNER_NEEDLE)) return null
  let record: Record<string, unknown> | null
  try {
    const parsed = JSON.parse(json) as unknown
    record =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
  } catch {
    return null
  }
  if (!record || record.type !== 'PLANNER_RESPONSE') return null
  const stepIndex = nonNegative(record.step_index)
  if (stepIndex === null) return null
  const input = nonNegative(record.input_tokens)
  const cacheRead = nonNegative(record.cache_read_tokens)
  const output = nonNegative(record.output_tokens)
  if (input === null && cacheRead === null && output === null) return null
  const cacheWrite =
    nonNegative(record.cache_write_tokens) ?? nonNegative(record.cache_creation_tokens)
  return {
    stepIndex,
    model: typeof record.model === 'string' && record.model !== '' ? record.model : null,
    createdAt: parseIsoTime(record.created_at),
    input: input ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite,
    output: output ?? 0,
  }
}

/** 倒序扫描指定 transcript.jsonl 文件，读取最新一条 PLANNER_RESPONSE 的用量。 */
export async function readLatestAgyStep(file: string): Promise<AgyStepUsage | null> {
  let found: AgyStepUsage | null = null
  try {
    await scanBackwards(
      file,
      (line) => {
        if (!line.includes(PLANNER_NEEDLE)) return false
        found = parseAgyPlannerStep(line.toString('utf8'))
        return found !== null
      },
      { limit: TAIL_BYTES },
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return found
}

/** 默认的 agy 步骤读取器，从本机 `~/.gemini/antigravity-cli/brain` 读取。 */
export function agyStepReader(home = os.homedir()): AgyStepReader {
  return async (sessionId) => {
    const file = agyTranscriptFile(sessionId, home)
    if (!file) return null
    return readLatestAgyStep(file).catch(() => null)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 跟踪同一 ACP 连接下所有 agy 会话的单步计时，并结合 transcript.jsonl 推送 `speed` 与 `lastRequest`。
 */
export class AgyMetrics {
  private readonly states = new Map<string, SessionState>()
  private readonly now: () => number
  private readonly retriesMs: readonly number[]

  constructor(
    private readonly reader: AgyStepReader,
    private readonly host: AgyMetricsHost,
    retriesMs: readonly number[] = DEFAULT_RETRIES_MS,
  ) {
    this.now = host.now ?? Date.now
    this.retriesMs = retriesMs
  }

  private stateOf(sessionId: string): SessionState {
    let state = this.states.get(sessionId)
    if (!state) {
      state = {
        sentAt: null,
        firstOutputAt: null,
        firstToolAt: null,
        openTools: new Set(),
        nextSentAt: null,
        lastStepIndex: null,
        baseline: null,
        chain: Promise.resolve(),
        generation: 0,
      }
      this.states.set(sessionId, state)
    }
    return state
  }

  /** 标记新创建的空会话，无需扫描历史基线。 */
  onNewSession(sessionId: string): void {
    const state = this.stateOf(sessionId)
    state.lastStepIndex = -1
    state.baseline = null
  }

  /** 为已恢复/加载的既有会话预读历史最新 step_index，避免把历史步骤算作本轮新请求。 */
  onExistingSession(sessionId: string): void {
    const state = this.stateOf(sessionId)
    if (state.lastStepIndex !== null || state.baseline) return
    const generation = state.generation
    state.baseline = this.reader(sessionId)
      .then((step) => {
        if (state.generation !== generation) return
        if (state.lastStepIndex === null) state.lastStepIndex = step ? step.stepIndex : -1
      })
      .catch(() => {
        if (state.generation !== generation) return
        if (state.lastStepIndex === null) state.lastStepIndex = -1
      })
  }

  /** 开始一轮 prompt 前调用：先确保历史基线已就绪，再记录请求发出时刻，彻底避免读写竞态。 */
  async preparePrompt(sessionId: string): Promise<void> {
    const state = this.stateOf(sessionId)
    if (state.lastStepIndex === null && !state.baseline) {
      this.onExistingSession(sessionId)
    }
    if (state.baseline) await state.baseline
    const now = this.now()
    state.sentAt = now
    state.firstOutputAt = null
    state.firstToolAt = null
    state.openTools.clear()
    state.nextSentAt = null
  }

  /** 处理一条 ACP session/update：维护本步时间戳并在收到 usage_update 时触发用量读取。 */
  onUpdate(sessionId: string, update: acp.SessionUpdate, replaying: boolean): void {
    if (replaying) return
    const state = this.stateOf(sessionId)
    const now = this.now()
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk':
      case 'agent_message_chunk': {
        // 如果上一轮工具已全部完成并留下了 nextSentAt，说明新的模型请求输出刚刚开始。
        if (
          state.firstOutputAt === null &&
          state.firstToolAt === null &&
          state.nextSentAt !== null
        ) {
          state.sentAt = state.nextSentAt
          state.nextSentAt = null
        }
        state.firstOutputAt ??= now
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        const shaped = fromAgy(update)
        const status = shaped.status
        const done = status === 'completed' || status === 'failed'
        if (!done) {
          // 首个工具调用出现意味着模型本步的生成已经结束，后续时间属于工具执行。
          if (state.firstToolAt === null) state.firstToolAt = now
          state.openTools.add(update.toolCallId)
        } else {
          state.openTools.delete(update.toolCallId)
          // 所有并行工具全部结束时，记录下一步模型请求的起点。
          if (state.openTools.size === 0) {
            state.nextSentAt = now
          }
        }
        return
      }
      case 'usage_update': {
        const snapshot: StepSnapshot = {
          sentAt: state.sentAt,
          firstOutputAt: state.firstOutputAt,
          endedAt: state.firstToolAt ?? now,
        }
        // 本步已采样，准备进入下一步计时。
        state.sentAt = state.nextSentAt ?? now
        state.firstOutputAt = null
        state.firstToolAt = null
        state.nextSentAt = null
        this.enqueueCapture(sessionId, state, snapshot)
        return
      }
    }
  }

  /** 一轮 prompt 结束时调用：若正常结束则兜底检查是否还有未消费的最终步骤；取消则丢弃在途计时。 */
  onPromptEnd(sessionId: string, stopReason: string): void {
    const state = this.states.get(sessionId)
    if (!state) return
    if (stopReason === 'cancelled') {
      state.generation++
      state.sentAt = null
      state.firstOutputAt = null
      state.firstToolAt = null
      state.openTools.clear()
      state.nextSentAt = null
      return
    }
    if (stopReason === 'end_turn' && (state.firstOutputAt !== null || state.firstToolAt !== null)) {
      const now = this.now()
      const snapshot: StepSnapshot = {
        sentAt: state.sentAt,
        firstOutputAt: state.firstOutputAt,
        endedAt: state.firstToolAt ?? now,
      }
      state.sentAt = now
      state.firstOutputAt = null
      state.firstToolAt = null
      state.nextSentAt = null
      this.enqueueCapture(sessionId, state, snapshot)
    }
  }

  /** 会话关闭或注销时清理状态并中止所有挂起重试。 */
  forget(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (!state) return
    state.generation++
    this.states.delete(sessionId)
  }

  /** 停止并清理全部会话状态。 */
  stop(): void {
    for (const state of this.states.values()) state.generation++
    this.states.clear()
  }

  private enqueueCapture(sessionId: string, state: SessionState, snapshot: StepSnapshot): void {
    const generation = state.generation
    state.chain = state.chain
      .then(() => this.capture(sessionId, state, snapshot, generation))
      .catch(() => {})
  }

  private async capture(
    sessionId: string,
    state: SessionState,
    snapshot: StepSnapshot,
    generation: number,
  ): Promise<void> {
    if (state.baseline) await state.baseline
    if (state.generation !== generation) return
    let step: AgyStepUsage | null = null
    for (let attempt = 0; attempt <= this.retriesMs.length; attempt++) {
      if (attempt > 0) await sleep(this.retriesMs[attempt - 1]!)
      if (state.generation !== generation) return
      const latest = await this.reader(sessionId).catch(() => null)
      if (latest && (state.lastStepIndex === null || latest.stepIndex > state.lastStepIndex)) {
        step = latest
        break
      }
    }
    if (!step || state.generation !== generation) return
    state.lastStepIndex = step.stepIndex
    const target = this.host.target(sessionId)
    if (!target) return
    const ctx = target.context()
    if (ctx.replaying || ctx.cancelling) return
    const session = ctx.thread.session
    const sentAt = latestTime(snapshot.sentAt, session.turnStartedAt)
    const sample = timeRequest(step.output, sentAt, snapshot.firstOutputAt, snapshot.endedAt)
    const speed = sample && addSpeedSample(session.speed, sample, session.turnStartedAt)
    const lastRequest: LastRequest = {
      at: sentAt ?? step.createdAt ?? snapshot.endedAt,
      input: step.input,
      cacheRead: step.cacheRead,
      cacheWrite: step.cacheWrite,
      output: step.output,
      ms: sentAt !== null && snapshot.endedAt >= sentAt ? snapshot.endedAt - sentAt : null,
    }
    target.apply({
      patches: [
        {
          op: 'session.update',
          changes: { ...(speed ? { speed } : {}), lastRequest },
        },
      ],
      effects: [],
    })
  }
}
