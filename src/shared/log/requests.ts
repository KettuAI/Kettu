// A client's request as an action record: its method and its parameters reduced to ids, choices,
// numbers and switches. Text, such as a prompt, a path or a search, appears only as its length.

import { writeLog } from './process-log'

// Keys whose short string values are ids or choices, never what the user wrote.
const CHOICE_KEYS = new Set([
  'agentId',
  'decision',
  'direction',
  'format',
  'harnessId',
  'kind',
  'level',
  'method',
  'mode',
  'optionId',
  'reason',
  'scope',
  'sort',
  'state',
  'status',
  'type',
])
const ID_KEY = /(?:^id|Id)$/
const IDS_KEY = /Ids$/
const SECRET_KEY = /key|token|secret|passw|credential/i
const MAX_ID_CHARS = 128
const MAX_LISTED_IDS = 20

// The last part of a method that only reads or watches; logged at debug, as windows poll them.
const READS = new Set([
  'avatarUrl',
  'blob',
  'branches',
  'changes',
  'check',
  'collect',
  'comments',
  'complete',
  'consents',
  'content',
  'context',
  'currentPullRequest',
  'details',
  'entry',
  'environment',
  'file',
  'fileDiff',
  'held',
  'incoming',
  'issue',
  'list',
  'listSessions',
  'options',
  'outline',
  'outlineTitles',
  'page',
  'pullRequest',
  'read',
  'readFirstOptions',
  'readOptions',
  'replay',
  'requests',
  'runs',
  'search',
  'snapshot',
  'stack',
  'status',
  'suggestionFile',
  'suggestions',
  'summary',
  'taskOutput',
  'tools',
  'total',
  'unwatch',
  'versions',
  'waiting',
  'watch',
  'resize',
  'attach',
])

// Keystrokes and flow control: too many to log, and a terminal's input is never logged.
const UNLOGGED = new Set(['terminals.input', 'terminals.ack'])

export function isReadMethod(method: string): boolean {
  const action = method.slice(method.lastIndexOf('.') + 1)
  return READS.has(action)
}

function summarizeValue(key: string, value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (SECRET_KEY.test(key) && !ID_KEY.test(key)) return '<omitted>'
  if (typeof value === 'string') {
    if ((ID_KEY.test(key) || CHOICE_KEYS.has(key)) && value.length <= MAX_ID_CHARS) return value
    return `<${value.length} chars>`
  }
  if (Array.isArray(value)) {
    if (IDS_KEY.test(key) && value.every((item) => typeof item === 'string')) {
      const ids = value.slice(0, MAX_LISTED_IDS) as string[]
      return value.length > ids.length ? [...ids, `<${value.length - ids.length} more>`] : ids
    }
    return `<${value.length} items>`
  }
  if (typeof value === 'object') return '<object>'
  return `<${typeof value}>`
}

export function summarizeParams(params: unknown): Record<string, unknown> | undefined {
  if (params === undefined || params === null) return undefined
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { params: summarizeValue('params', params) }
  }
  const summary: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) summary[key] = summarizeValue(key, value)
  return summary
}

/** A paired device's request answered this long after it arrived is logged with its answer. */
export const SLOW_ANSWER_MS = 250

/** A paired device's answer this large, in bytes, is logged with how long it took. */
export const LARGE_ANSWER_BYTES = 64 * 1024

export interface DeviceAnswer {
  device: string
  /** From the request's arrival to its answer, waiting for a free slot included. */
  ms: number
  /** Of `ms`, how long the request waited for a free slot. */
  waitedMs: number
  /** The answer's JSON in UTF-8, binary values counted as their bytes. */
  bytes: number
  /** It got the answer of an identical read already in flight. */
  shared: boolean
  /** The error's code when it failed. */
  error?: string
}

/** 已配对设备单次请求回答从解密请求到写出最后一帧的送达耗时。 */
export interface DeviceDelivery {
  device: string
  /** 从解密请求到写出最后一帧的总耗时（毫秒）。 */
  ms: number
  /** 从解密请求到回答入队的主机处理耗时（毫秒）。 */
  hostMs: number
  /** 在设备发件箱中排队等待写出的耗时（毫秒）。 */
  queueMs: number
  /** 加密并写出所有帧直至最后一帧完成的耗时（毫秒）。 */
  writeMs: number
  /** 入队时排在前面的待发与在途字节数。 */
  queuedBytes: number
  /** 本条回答的 UTF-8 字节数。 */
  bytes: number
  /** 若返回错误，则为错误码。 */
  error?: string
}

/** 已配对设备单次实时更新（如补丁批次或摘要事件）从刷出到写出完成的耗时。 */
export interface DeviceLiveUpdate {
  device: string
  /** 从刷出入队到写出最后一帧的总耗时（毫秒）。 */
  ms: number
  /** 在发件箱中等待窗口或节流节奏的耗时（毫秒）。 */
  queueMs: number
  /** 加密并写出所有帧直至最后一帧完成的耗时（毫秒）。 */
  writeMs: number
  /** 入队时排在前面的待发与在途字节数。 */
  queuedBytes: number
  /** 本次写出消息的 UTF-8 字节数。 */
  bytes: number
  /** 若多批补丁在队列中合并，记录合并批次数。 */
  merged?: number
  /** 关联的会话 ID（如有）。 */
  sessionId?: string
}

/** 已配对设备单次推送从入队到被推送网关接收的耗时。 */
export interface DevicePushTiming {
  device: string
  /** 推送通道与类型，不含正文或令牌。 */
  kind: 'alert' | 'background' | 'activity' | 'web-push'
  /** 从入队到网关返回接收的总耗时（毫秒）。 */
  ms: number
  /** 最终成功那次请求发送到网关返回接收的耗时（毫秒）。 */
  gatewayMs: number
  /** 尝试次数（含重试）。 */
  attempts: number
}

/**
 * Logs a paired device's answer at `info` when it was slow or large, so a slow screen on a device
 * splits into the host's time and the network's. Call it under the request's operation.
 */
export function logDeviceAnswer(method: string, answer: DeviceAnswer): void {
  if (answer.ms < SLOW_ANSWER_MS && answer.bytes < LARGE_ANSWER_BYTES) return
  const { device, ms, waitedMs, bytes, shared, error } = answer
  writeLog('info', 'request', `${method} answered`, {
    device,
    ms,
    ...(waitedMs > 0 ? { waitedMs } : {}),
    bytes,
    ...(shared ? { shared } : {}),
    ...(error ? { error } : {}),
  })
}

/**
 * 记录远程主机侧单次请求从解密到写出回答最后一帧的送达耗时与前方队列积压字节；
 * 慢请求、大回答、队列积压明显或出错时写 `info`，其余写 `debug`，统一归入 request 日志与诊断包。
 */
export function logDeviceDelivery(method: string, delivery: DeviceDelivery): void {
  const { device, ms, hostMs, queueMs, writeMs, queuedBytes, bytes, error } = delivery
  const notable =
    ms >= SLOW_ANSWER_MS ||
    bytes >= LARGE_ANSWER_BYTES ||
    queuedBytes >= LARGE_ANSWER_BYTES ||
    error !== undefined
  writeLog(notable ? 'info' : 'debug', 'request', `${method} delivered`, {
    device,
    ms,
    hostMs,
    queueMs,
    writeMs,
    queuedBytes,
    bytes,
    ...(error ? { error } : {}),
  })
}

/**
 * 记录远程主机侧单次实时更新从刷出到写完的耗时与前方积压字节；
 * 慢更新、大消息或队列积压明显时写 `info`，其余写 `debug`。
 */
export function logDeviceLiveUpdate(kind: string, update: DeviceLiveUpdate): void {
  const { device, ms, queueMs, writeMs, queuedBytes, bytes, merged, sessionId } = update
  const notable =
    ms >= SLOW_ANSWER_MS || bytes >= LARGE_ANSWER_BYTES || queuedBytes >= LARGE_ANSWER_BYTES
  writeLog(notable ? 'info' : 'debug', 'request', `${kind} written`, {
    device,
    ms,
    queueMs,
    writeMs,
    queuedBytes,
    bytes,
    ...(merged && merged > 1 ? { merged } : {}),
    ...(sessionId ? { sessionId } : {}),
  })
}

/** 记录单次推送从入队到推送网关接收的耗时，归入 request 日志与诊断包。 */
export function logDevicePush(push: DevicePushTiming): void {
  const { device, kind, ms, gatewayMs, attempts } = push
  writeLog('info', 'request', 'push accepted', {
    device,
    kind,
    ms,
    gatewayMs,
    attempts,
  })
}

/** How long a client's repeats of its last request are counted before the count is written. */
export const REQUEST_REPEAT_MS = 10_000

interface Last {
  key: string
  method: string
  data: Record<string, unknown>
  /** Repeats since the request or the count was last written. */
  repeats: number
  timer: ReturnType<typeof setTimeout> | null
}

/** Each client's last request, by device id or '' for the windows. */
const lasts = new Map<string, Last>()

function levelOf(method: string): 'debug' | 'info' {
  return isReadMethod(method) ? 'debug' : 'info'
}

/** The record's key, the same whatever order the params' keys came in. */
function recordKey(method: string, data: Record<string, unknown>): string {
  const sorted = Object.keys(data)
    .sort()
    .map((key) => [key, data[key]])
  return `${method}\0${JSON.stringify(sorted)}`
}

function writeRepeats(last: Last): void {
  if (last.timer) clearTimeout(last.timer)
  last.timer = null
  if (last.repeats === 0) return
  writeLog(levelOf(last.method), 'request', `${last.method} repeated ${last.repeats} times`, {
    ...last.data,
    repeated: last.repeats,
  })
  last.repeats = 0
}

/**
 * Logs a client's request where the host receives it: `info` for actions, `debug` for reads. A
 * client's repeats of its last request are counted, and the count is written once a different
 * request comes from it or `REQUEST_REPEAT_MS` after the first repeat.
 */
export function logRequest(method: string, params: unknown, device: string | null): void {
  if (UNLOGGED.has(method)) return
  const data = { ...(device ? { device } : {}), ...summarizeParams(params) }
  const client = device ?? ''
  const key = recordKey(method, data)
  const last = lasts.get(client)
  if (last?.key === key) {
    last.repeats++
    if (!last.timer) {
      last.timer = setTimeout(() => writeRepeats(last), REQUEST_REPEAT_MS)
      last.timer.unref()
    }
    return
  }
  if (last) writeRepeats(last)
  lasts.set(client, { key, method, data, repeats: 0, timer: null })
  writeLog(levelOf(method), 'request', method, data)
}
