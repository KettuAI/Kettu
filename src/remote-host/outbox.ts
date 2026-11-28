// What the host sends one device session, in order. A device of version 2 acknowledges what it
// applies: each message is numbered as it is written and kept until then, so the connection that
// takes the session over gets again what the last one may have lost. Past a window of messages it
// has not acknowledged the rest wait; session patches waiting merge, go at the pace the device asks
// for, and are dropped once too much waits, the device told to fetch its sessions again. Without
// acknowledgements, as with a version 1 device, messages go straight to the channel.

import { MAX_MESSAGE, type Channel, type ChannelMessage } from '@shared/remote/channel'
import { MAX_PACE_MS, type Resync } from '@shared/remote/protocol'
import type { Transport } from '@shared/remote/transport'
import { coalescePatches, type Patch } from '@shared/thread'

export interface OutboxLimits {
  /** Messages written and not acknowledged, past which the next ones wait. */
  inFlight: number
  /** 在途未确认字节上限，超出后普通与大块消息等待设备确认释放窗口。 */
  inFlightBytes: number
  /** 高优小消息在普通字节窗口被大消息占满时可额外使用的在途预留字节预算。 */
  highPriorityReserveBytes: number
  /** 认定为高优小消息的单条字节阈值（小回答与小补丁批次）。 */
  smallMessageBytes: number
  /** Messages waiting, past which the patches among them are dropped. */
  queued: number
  /** 排队总字节上限，超出后丢弃待发补丁并下发 resync。 */
  queuedBytes: number
  /** Messages waiting or not acknowledged, past which the device cannot keep up at all. */
  kept: number
  /** Bytes of patches that merge into one batch at most. */
  mergedBytes: number
}

export const OUTBOX_LIMITS: OutboxLimits = {
  inFlight: 256,
  inFlightBytes: 512 * 1024,
  highPriorityReserveBytes: 64 * 1024,
  smallMessageBytes: 16 * 1024,
  queued: 1024,
  queuedBytes: 8 * 1024 * 1024,
  kept: 4096,
  mergedBytes: 256 * 1024,
}

/** 视为大块消息的字节阈值，高于该值的 JSON 回答排入低优大块通道。 */
const BULK_MESSAGE_BYTES = 64 * 1024

/** Stream bytes a device of version 2 may have on their way before downloads wait. */
export const IN_FLIGHT_BYTES = 1024 * 1024

export interface OutboxConnection {
  channel: Pick<Channel, 'send'>
  transport: Pick<Transport, 'buffered' | 'drained'>
}

/** 发件箱追踪上下文：区分请求回答与实时事件更新。 */
export type OutboxTrace =
  | {
      kind: 'answer'
      method: string
      /** 回答所属会话 ID（若该请求作用于特定会话，防止同会话补丁越过自身回答）。 */
      sessionId?: string
      /** 请求完成解密的时刻（毫秒）。 */
      startedAt: number
      error?: string
    }
  | {
      kind: 'live'
      eventType: string
      sessionId?: string
      /** 实时更新刷出进入发件箱的时刻（毫秒）。 */
      startedAt: number
    }

/** 单条消息最后一帧写出完成后的送达计时指标。 */
export interface OutboxWriteTiming {
  trace: OutboxTrace
  enqueuedAt: number
  sendStartedAt: number
  writtenAt: number
  /** 入队时排在该消息前面的待发与在途字节数。 */
  queuedBytes: number
  bytes: number
  /** 若经过补丁合并，为合并的批次数。 */
  merged: number
}

export interface OutboxOptions {
  /** Whether the device acknowledges what it applies, as it does from version 2. */
  acks: boolean
  /** Even what is kept after dropping the patches is too much: the device cannot keep up. */
  overflowed(): void
  /** Messages dropped for a device that fell behind, for the log. */
  dropped(count: number): void
  /** 每条带追踪上下文的消息最后一帧首次写出完成时回调。 */
  onWritten?: (timing: OutboxWriteTiming) => void
  limits?: Partial<OutboxLimits>
  now?: () => number
}

interface Batch {
  sessionId: string
  from: number
  seq: number
  patches: Patch[]
}

type Priority = 'high' | 'normal' | 'bulk'

interface Entry {
  message: ChannelMessage
  /** A JSON message's length as text, or a bytes message's bytes. */
  size: number
  stream: boolean
  /** 调度优先级：高优小消息可在遵守会话顺序前提下越过排队的普通/大块消息。 */
  priority: Priority
  /** 所属会话 ID（补丁或作用于某会话的回答），用于禁止同会话补丁越过自身回答。 */
  sessionId: string | null
  /** 是否为针对设备请求的回答（response/error）。 */
  isAnswer: boolean
  /** Its number once written, counted from 1. */
  seq: number
  /** A `session.patches` event's batch, which later ones of its session may merge into. */
  batch: Batch | null
  /** For a message that says the whole of some state: only the latest of its key is kept. */
  key: string | null
  resync: boolean
  /** 可选送达计时追踪信息。 */
  trace: OutboxTrace | null
  /** 入队时刻（毫秒）。 */
  enqueuedAt: number
  /** 入队时排在前面的待发与在途字节数。 */
  queuedBytes: number
  /** 合并的批次数（默认为 1）。 */
  merged: number
  /** 是否已上报首次写出完成，避免断线重传重复记录。 */
  recorded: boolean
}

export class Outbox {
  private connection: OutboxConnection | null = null
  private readonly limits: OutboxLimits
  private readonly now: () => number
  /** Written and not acknowledged, oldest first. */
  private unacked: Entry[] = []
  /** Not written yet, in order. */
  private queued: Entry[] = []
  /** Entries waiting that are not patches, whose turn ends a wait for the pace. */
  private queuedOther = 0
  /** 当前排队中尚未开始写出的总字节数。 */
  private queuedBytes = 0
  /** 已写出但尚未收到设备确认的总字节数。 */
  private unackedBytes = 0
  /** 已写出但尚未确认的高优消息字节数（计入高优预留窗口）。 */
  private unackedHighBytes = 0
  /** 已交给 channel.send 但最后一帧尚未写完的总字节数。 */
  private writingBytes = 0
  private written = 0
  private acked = 0
  /** Stream bytes waiting or not acknowledged. */
  private streamBytes = 0
  private paceMs = 0
  private lastPatches = Number.NEGATIVE_INFINITY
  private paceTimer: ReturnType<typeof setTimeout> | null = null
  private overflowAt: number
  private overflowBytesAt: number
  private readonly drains = new Set<() => void>()
  private readonly flushes = new Set<() => void>()
  /** Without acknowledgements, the latest message given to the channel. */
  private sending: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly options: OutboxOptions) {
    this.limits = { ...OUTBOX_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
    this.overflowAt = this.limits.queued
    this.overflowBytesAt = this.limits.queuedBytes
  }

  /**
   * Whether a connection whose device received the first `received` messages can take over: it
   * acknowledged no fewer before and cannot have more than were written.
   */
  canResume(received: number): boolean {
    return this.options.acks && received >= this.acked && received <= this.written
  }

  /** Writes through a connection from now on, first again what it wrote after `received`. */
  attach(connection: OutboxConnection, received = 0): void {
    if (this.closed) return
    this.connection = connection
    if (!this.options.acks) return
    this.trim(received)
    for (const entry of this.unacked) this.transmit(connection, entry)
    this.pump()
  }

  /** The connection is gone; what comes waits for the next. */
  detach(): void {
    this.connection = null
    this.stopPace()
    this.flushed()
  }

  /** 当前排在队列中、正在写帧及底层传输缓冲中的待发字节总数。 */
  private pendingBytes(): number {
    return this.queuedBytes + this.writingBytes + (this.connection?.transport.buffered() ?? 0)
  }

  /** Sends a message after every one before it; rejects when it cannot go, as when too long. */
  push(message: ChannelMessage, trace?: OutboxTrace): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The device session ended'))
    let size: number
    if (message.kind === 'bytes') {
      size = message.data.length
    } else {
      const text = JSON.stringify(message.value) as string | undefined
      if (text === undefined) return Promise.reject(new TypeError('Channel message is not JSON'))
      // Checked here, as the channel would, so a message that cannot go never takes a number.
      size = Buffer.byteLength(text)
      if (size > MAX_MESSAGE) {
        return Promise.reject(new RangeError('Channel message is longer than 32 MiB'))
      }
    }
    const enqueuedAt = this.now()
    const aheadBytes = this.pendingBytes()
    if (!this.options.acks) {
      const connection = this.connection
      if (!connection) return Promise.reject(new Error('The device is not connected'))
      this.writingBytes += size
      const sent = connection.channel.send(message)
      sent.then(
        () => {
          this.writingBytes = Math.max(0, this.writingBytes - size)
          if (trace) {
            this.options.onWritten?.({
              trace,
              enqueuedAt,
              sendStartedAt: enqueuedAt,
              writtenAt: this.now(),
              queuedBytes: aheadBytes,
              bytes: size,
              merged: 1,
            })
          }
        },
        () => {
          this.writingBytes = Math.max(0, this.writingBytes - size)
        },
      )
      this.sending = sent.catch(() => {})
      return sent
    }
    this.enqueue(
      entryOf(message, size, trace ?? null, enqueuedAt, aheadBytes, this.limits.smallMessageBytes),
    )
    return Promise.resolve()
  }

  /** The device applied the first `received` messages. */
  ack(received: unknown): void {
    if (!this.options.acks || typeof received !== 'number' || !Number.isSafeInteger(received)) {
      return
    }
    if (this.trim(received)) this.pump()
  }

  /** Forgets what the device has; whether that was more than it said before. */
  private trim(received: number): boolean {
    if (received <= this.acked || received > this.written) return false
    this.acked = received
    let done = 0
    let freed = false
    while (done < this.unacked.length && this.unacked[done]!.seq <= received) {
      const entry = this.unacked[done++]!
      this.unackedBytes = Math.max(0, this.unackedBytes - entry.size)
      if (entry.priority === 'high') {
        this.unackedHighBytes = Math.max(0, this.unackedHighBytes - entry.size)
      }
      if (entry.stream) {
        this.streamBytes -= entry.size
        freed = true
      }
    }
    this.unacked = this.unacked.slice(done)
    if (freed) this.wake()
    if (this.unacked.length === 0 && this.queued.length === 0) this.flushed()
    return true
  }

  /** The device wants patches at most every `ms`; 0 sends them as they come. */
  pace(ms: unknown): void {
    if (!this.options.acks || typeof ms !== 'number' || !Number.isFinite(ms)) return
    this.paceMs = Math.min(MAX_PACE_MS, Math.max(0, Math.round(ms)))
    this.stopPace()
    this.pump()
  }

  /** Stream bytes on their way, as a transport's buffered says, which downloads pace on. */
  buffered(): number {
    if (this.options.acks) return this.streamBytes
    return this.connection?.transport.buffered() ?? 0
  }

  /** Settles once some stream bytes on their way have arrived, or the session ended. */
  drained(): Promise<void> {
    if (!this.options.acks) return this.connection?.transport.drained() ?? Promise.resolve()
    if (this.closed || this.streamBytes === 0) return Promise.resolve()
    return new Promise((resolve) => this.drains.add(resolve))
  }

  /**
   * Settles once everything pushed so far has reached the device: acknowledged by a device that
   * acknowledges, otherwise sent and drained from the transport. Settles at once without a
   * connection, or once the connection is gone, since nothing more can arrive on it.
   */
  flush(): Promise<void> {
    const connection = this.connection
    if (this.closed || !connection) return Promise.resolve()
    if (!this.options.acks) {
      return this.sending.then(() =>
        this.connection === connection ? connection.transport.drained() : undefined,
      )
    }
    if (this.unacked.length === 0 && this.queued.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.flushes.add(resolve))
  }

  /** The session ended: nothing more is sent, and what waited goes. */
  close(): void {
    this.closed = true
    this.detach()
    this.queued = []
    this.unacked = []
    this.queuedOther = 0
    this.queuedBytes = 0
    this.unackedBytes = 0
    this.unackedHighBytes = 0
    this.writingBytes = 0
    this.streamBytes = 0
    this.wake()
    this.flushed()
  }

  private enqueue(entry: Entry): void {
    if (entry.batch && this.merge(entry.batch, entry.size, entry.trace)) return this.pump()
    this.queued.push(entry)
    this.queuedBytes += entry.size
    if (!entry.batch) this.queuedOther++
    if (entry.stream) this.streamBytes += entry.size
    if (this.queued.length > this.overflowAt || this.queuedBytes > this.overflowBytesAt) {
      this.overflow()
    }
    if (this.queued.length + this.unacked.length > this.limits.kept) {
      return this.options.overflowed()
    }
    this.pump()
  }

  /**
   * Adds a batch to the waiting one of its session it follows, when only patches wait after that
   * one, so nothing else changes places with it.
   */
  private merge(batch: Batch, size: number, trace: OutboxTrace | null): boolean {
    for (let i = this.queued.length - 1; i >= 0; i--) {
      const waiting = this.queued[i]!
      if (!waiting.batch) return false
      if (waiting.batch.sessionId !== batch.sessionId) continue
      if (waiting.batch.seq + 1 !== batch.from) return false
      if (waiting.size + size > this.limits.mergedBytes) return false
      waiting.batch.seq = batch.seq
      for (const patch of batch.patches) waiting.batch.patches.push(patch)
      waiting.size += size
      waiting.merged += 1
      if (!waiting.trace && trace) waiting.trace = trace
      waiting.priority = classifyPriority(
        waiting.message,
        waiting.size,
        waiting.batch,
        this.limits.smallMessageBytes,
      )
      this.queuedBytes += size
      return true
    }
    return false
  }

  /**
   * Too much waits: the patches go, each state keeps only its latest, and the device is told to
   * fetch its sessions again.
   */
  private overflow(): void {
    const latest = new Map<string, Entry>()
    for (const entry of this.queued) if (entry.key) latest.set(entry.key, entry)
    let patches = 0
    const kept = this.queued.filter((entry) => {
      if (entry.batch) {
        patches++
        return false
      }
      return entry.key === null || latest.get(entry.key) === entry
    })
    const dropped = this.queued.length - kept.length
    this.queued = kept
    if (patches > 0 && !kept.some((entry) => entry.resync)) {
      const resync: Resync = { type: 'resync' }
      const size = JSON.stringify(resync).length
      kept.push({
        ...entryOf(
          { kind: 'json', value: resync },
          size,
          null,
          this.now(),
          0,
          this.limits.smallMessageBytes,
        ),
        priority: 'high',
        resync: true,
      })
    }
    this.queuedOther = kept.length
    this.queuedBytes = kept.reduce((sum, item) => sum + item.size, 0)
    if (dropped > 0) this.options.dropped(dropped)
    // What is left stays until the device reads it, so the next look waits for twice as much.
    this.overflowAt = Math.max(this.limits.queued, this.queued.length * 2)
    this.overflowBytesAt = Math.max(this.limits.queuedBytes, this.queuedBytes * 2)
  }

  private pump(): void {
    const connection = this.connection
    if (!connection || this.closed || !this.options.acks) return
    while (this.queued.length > 0 && this.unacked.length < this.limits.inFlight) {
      const picked = this.pickNextIndex()
      if (picked === 'pace') {
        const due = this.lastPatches + this.paceMs - this.now()
        if (due > 0) return this.schedulePace(due)
        continue
      }
      if (picked < 0) break
      const [entry] = this.queued.splice(picked, 1)
      if (!entry) break
      this.queuedBytes = Math.max(0, this.queuedBytes - entry.size)
      if (entry.batch) this.lastPatches = this.now()
      else this.queuedOther--
      entry.message = finished(entry)
      entry.seq = ++this.written
      this.unacked.push(entry)
      this.unackedBytes += entry.size
      if (entry.priority === 'high') this.unackedHighBytes += entry.size
      this.transmit(connection, entry)
    }
    if (this.queued.length <= this.limits.queued) this.overflowAt = this.limits.queued
    if (this.queuedBytes <= this.limits.queuedBytes) this.overflowBytesAt = this.limits.queuedBytes
  }

  /**
   * 按字节预算与优先级挑选下一条可写出的排队消息：
   * - 高优小消息可越过前面排队的大块/普通消息，但绝不打破同会话补丁顺序、不越过同会话回答、不越过 resync 与同 stateKey 状态；
   * - 当普通字节窗口被在途大消息占满时，高优小消息仍可使用独立的预留字节预算穿透发送；
   * - 通道完全空闲（unacked 为空）时允许任意单条超大消息发出，避免饥饿。
   */
  private pickNextIndex(): number | 'pace' {
    const paceBlocked =
      this.queuedOther === 0 && this.paceMs > 0 && this.lastPatches + this.paceMs - this.now() > 0

    // 1. 优先扫描高优消息（允许合法插队，或在普通窗口已满时使用高优预留窗口）
    for (let i = 0; i < this.queued.length; i++) {
      const entry = this.queued[i]!
      if (entry.priority !== 'high') continue
      if (entry.batch && paceBlocked) continue
      if (!this.fitsByteWindow(entry)) continue
      if (i > 0 && !this.canOvertake(i, entry)) continue
      return i
    }

    // 2. 没有可立即发出的高优消息时，按队首 FIFO 尝试发送普通/大块消息
    const head = this.queued[0]
    if (!head) return -1
    if (head.batch && paceBlocked) return 'pace'
    if (this.fitsByteWindow(head)) return 0
    return paceBlocked ? 'pace' : -1
  }

  /** 检查该消息是否满足当前在途字节流控窗口（通道空闲必放行，高优可使用独立预留额度）。 */
  private fitsByteWindow(entry: Entry): boolean {
    if (this.unacked.length === 0) return true
    if (this.unackedBytes + entry.size <= this.limits.inFlightBytes) return true
    if (
      entry.priority === 'high' &&
      this.unackedHighBytes + entry.size <= this.limits.highPriorityReserveBytes
    ) {
      return true
    }
    return false
  }

  /** 检查位于队列 `index` 处的高优消息是否可以安全越过其前面的全部排队消息。 */
  private canOvertake(index: number, entry: Entry): boolean {
    for (let i = 0; i < index; i++) {
      const earlier = this.queued[i]!
      // 补丁绝不越过 resync 屏障，也不越过同会话更早的补丁、回答或任何同会话消息
      if (entry.batch) {
        if (earlier.resync) return false
        if (earlier.sessionId !== null && earlier.sessionId === entry.batch.sessionId) return false
      }
      // 同一会话的回答之间保持 FIFO；同会话回答不越过该会话更早的同状态或回答
      if (entry.isAnswer && entry.sessionId !== null) {
        if (earlier.isAnswer && earlier.sessionId === entry.sessionId) return false
      }
      // 相同状态键（例如同一会话的两条 session.summary）严格保序，防止旧状态覆盖新状态
      if (entry.key !== null && earlier.key === entry.key) return false
      // resync 屏障不越过它前面的高优控制消息
      if (entry.resync && earlier.priority === 'high') return false
    }
    return true
  }

  private transmit(connection: OutboxConnection, entry: Entry): void {
    const sendStartedAt = this.now()
    const bytes = entry.size
    this.writingBytes += bytes
    // A channel fails only as its connection ends, and the entry waits for the next one.
    connection.channel.send(entry.message).then(
      () => {
        this.writingBytes = Math.max(0, this.writingBytes - bytes)
        if (!entry.recorded && entry.trace) {
          entry.recorded = true
          this.options.onWritten?.({
            trace: entry.trace,
            enqueuedAt: entry.enqueuedAt,
            sendStartedAt,
            writtenAt: this.now(),
            queuedBytes: entry.queuedBytes,
            bytes,
            merged: entry.merged,
          })
        }
      },
      () => {
        this.writingBytes = Math.max(0, this.writingBytes - bytes)
      },
    )
  }

  private schedulePace(due: number): void {
    if (this.paceTimer) return
    this.paceTimer = setTimeout(() => {
      this.paceTimer = null
      this.pump()
    }, due)
  }

  private stopPace(): void {
    if (this.paceTimer) clearTimeout(this.paceTimer)
    this.paceTimer = null
  }

  private flushed(): void {
    const flushes = [...this.flushes]
    this.flushes.clear()
    for (const resolve of flushes) resolve()
  }

  private wake(): void {
    const drains = [...this.drains]
    this.drains.clear()
    for (const resolve of drains) resolve()
  }
}

function entryOf(
  message: ChannelMessage,
  size: number,
  trace: OutboxTrace | null,
  enqueuedAt: number,
  queuedBytes: number,
  smallMessageBytes: number,
): Entry {
  const value = message.kind === 'json' ? message.value : null
  const batch = batchOf(value)
  const isAnswer =
    typeof value === 'object' &&
    value !== null &&
    ((value as { type?: unknown }).type === 'response' ||
      (value as { type?: unknown }).type === 'response.stream' ||
      (value as { type?: unknown }).type === 'error')
  const sessionId = batch?.sessionId ?? trace?.sessionId ?? eventSessionId(value)
  return {
    message,
    size,
    stream: message.kind === 'bytes',
    priority: classifyPriority(message, size, batch, smallMessageBytes),
    sessionId,
    isAnswer,
    seq: 0,
    batch,
    key: stateKey(value),
    resync: false,
    trace,
    enqueuedAt,
    queuedBytes,
    merged: 1,
    recorded: false,
  }
}

/** 通道控制类高优消息类型。 */
const HIGH_CONTROL_TYPES: ReadonlySet<string> = new Set([
  'resync',
  'relay',
  'addresses',
  'terminal',
  'renamed',
  'host.renamed',
  'notifications.withdrawn',
])

/** 根据消息种类与大小判定发件箱调度优先级。 */
function classifyPriority(
  message: ChannelMessage,
  size: number,
  batch: Batch | null,
  smallMessageBytes: number,
): Priority {
  if (message.kind === 'bytes') return 'bulk'
  const value = message.value
  if (typeof value !== 'object' || value === null) {
    return size > BULK_MESSAGE_BYTES ? 'bulk' : 'normal'
  }
  const { type, event } = value as { type?: unknown; event?: unknown }
  if (typeof type === 'string' && HIGH_CONTROL_TYPES.has(type)) return 'high'
  if (type === 'response' || type === 'response.stream' || type === 'error') {
    if (size <= smallMessageBytes) return 'high'
    return size > BULK_MESSAGE_BYTES ? 'bulk' : 'normal'
  }
  if (batch !== null) {
    if (size <= smallMessageBytes) return 'high'
    return size > BULK_MESSAGE_BYTES ? 'bulk' : 'normal'
  }
  if (type === 'event' && typeof event === 'object' && event !== null) {
    const ev = event as Record<string, unknown>
    if (ev.type === 'workflows.suggestion' || ev.type === 'session.removed') return 'high'
    if (ev.type === 'session.summary' && typeof ev.summary === 'object' && ev.summary !== null) {
      const summary = ev.summary as { permissionCount?: unknown; attention?: unknown }
      if (
        (typeof summary.permissionCount === 'number' && summary.permissionCount > 0) ||
        summary.attention === 'permission'
      ) {
        return 'high'
      }
    }
  }
  return size > BULK_MESSAGE_BYTES ? 'bulk' : 'normal'
}

/** 提取事件体中绑定的会话 ID（供未显式传入 trace 时兜底保持同会话顺序）。 */
function eventSessionId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, event } = value as { type?: unknown; event?: unknown }
  if (type !== 'event' || typeof event !== 'object' || event === null) return null
  const ev = event as Record<string, unknown>
  if (typeof ev.sessionId === 'string') return ev.sessionId
  if (
    ev.type === 'session.summary' &&
    typeof ev.summary === 'object' &&
    ev.summary !== null &&
    typeof (ev.summary as { id?: unknown }).id === 'string'
  ) {
    return (ev.summary as { id: string }).id
  }
  return null
}

/** The message an entry sends: a merged batch says the first seq it covers. */
function finished(entry: Entry): ChannelMessage {
  const { batch } = entry
  if (!batch || batch.from === batch.seq) return entry.message
  const { sessionId, from, seq } = batch
  const merged = { sessionId, seq, from, patches: coalescePatches(batch.patches) }
  return {
    kind: 'json',
    value: { type: 'event', event: { type: 'session.patches', batch: merged } },
  }
}

/** The batch of a `session.patches` event, copied so merging leaves the message as it was. */
function batchOf(value: unknown): Batch | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, event } = value as { type?: unknown; event?: unknown }
  if (type !== 'event' || typeof event !== 'object' || event === null) return null
  const { type: kind, batch } = event as { type?: unknown; batch?: unknown }
  if (kind !== 'session.patches' || typeof batch !== 'object' || batch === null) return null
  const { sessionId, seq, from, patches } = batch as Record<string, unknown>
  if (typeof sessionId !== 'string' || !Number.isSafeInteger(seq) || from !== undefined) {
    return null
  }
  if (!Array.isArray(patches)) return null
  return { sessionId, from: seq as number, seq: seq as number, patches: [...(patches as Patch[])] }
}

/** Events whose newest one says all their kind does, of the agent host's and the host's own. */
const WHOLE_STATES: ReadonlySet<string> = new Set([
  'projects.changed',
  'environment.changed',
  'git.tools',
  'star.changed',
  'usage.changed',
  'usage.status',
  'idleRelease.changed',
  'artifacts.changed',
  'memory.changed',
  'workflows.changed',
  'remote.changed',
  'sharing.changed',
  'updates.changed',
  'diagnostics.changed',
  'themes.changed',
])

/** The channel's own messages whose newest one says all their kind does. */
const CHANNEL_STATES: ReadonlySet<string> = new Set([
  'addresses',
  'terminal',
  'renamed',
  'host.renamed',
])

function idKey(kind: string, id: unknown): string | null {
  return typeof id === 'string' ? `${kind}:${id}` : null
}

/** What a message says the whole of, when the newest one makes the ones before it worthless. */
function stateKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, event } = value as { type?: unknown; event?: unknown }
  if (typeof type === 'string' && CHANNEL_STATES.has(type)) return type
  if (type !== 'event' || typeof event !== 'object' || event === null) return null
  const fields = event as Record<string, unknown>
  const of = (key: string): Record<string, unknown> =>
    (typeof fields[key] === 'object' && fields[key] !== null ? fields[key] : {}) as Record<
      string,
      unknown
    >
  const kind = fields.type
  switch (kind) {
    case 'session.summary':
      return idKey('session', of('summary').id)
    case 'session.removed':
      return idKey('session', fields.sessionId)
    case 'session.returned':
      return fields.sessionId === null ? 'returned' : idKey('returned', fields.sessionId)
    case 'session.viewers':
      return idKey('viewers', fields.sessionId)
    case 'browser.tabs':
      return idKey('browser.tabs', fields.sessionId)
    case 'agent.status':
      return idKey('agent', of('status').id)
    case 'agent.removed':
      return idKey('agent', fields.agentId)
    case 'agent.options':
      return idKey('agent.options', of('options').agentId)
    case 'git.changed':
      return idKey('git', of('status').projectPath)
    case 'git.pr':
      return idKey('git.pr', fields.projectPath)
    case 'git.reference':
      return idKey('git.reference', fields.url)
    case 'files.changed':
      return idKey('files', fields.projectPath)
    case 'artifacts.version':
    case 'artifacts.seen':
    case 'artifacts.activity':
    case 'artifacts.comments':
      return idKey(kind, fields.id)
    case 'routine.changed':
      return idKey('routine', of('routine').id)
    case 'routine.removed':
      return idKey('routine', fields.routineId)
    case 'routine.run':
      return idKey('routine.run', of('run').id)
    case 'task.changed':
      return idKey('task', of('task').id)
    case 'task.removed':
      return idKey('task', fields.taskId)
    case 'workflows.suggestion':
      return idKey('workflows.suggestion', of('suggestion').id)
    default:
      return typeof kind === 'string' && WHOLE_STATES.has(kind) ? kind : null
  }
}
