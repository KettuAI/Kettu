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
  /** Messages waiting, past which the patches among them are dropped. */
  queued: number
  /** Messages waiting or not acknowledged, past which the device cannot keep up at all. */
  kept: number
  /** Bytes of patches that merge into one batch at most. */
  mergedBytes: number
}

export const OUTBOX_LIMITS: OutboxLimits = {
  inFlight: 256,
  queued: 1024,
  kept: 4096,
  mergedBytes: 256 * 1024,
}

/** Stream bytes a device of version 2 may have on their way before downloads wait. */
export const IN_FLIGHT_BYTES = 1024 * 1024

export interface OutboxConnection {
  channel: Pick<Channel, 'send'>
  transport: Pick<Transport, 'buffered' | 'drained'>
}

export interface OutboxOptions {
  /** Whether the device acknowledges what it applies, as it does from version 2. */
  acks: boolean
  /** Even what is kept after dropping the patches is too much: the device cannot keep up. */
  overflowed(): void
  /** Messages dropped for a device that fell behind, for the log. */
  dropped(count: number): void
  limits?: Partial<OutboxLimits>
  now?: () => number
}

interface Batch {
  sessionId: string
  from: number
  seq: number
  patches: Patch[]
}

interface Entry {
  message: ChannelMessage
  /** A JSON message's length as text, or a bytes message's bytes. */
  size: number
  stream: boolean
  /** Its number once written, counted from 1. */
  seq: number
  /** A `session.patches` event's batch, which later ones of its session may merge into. */
  batch: Batch | null
  /** For a message that says the whole of some state: only the latest of its key is kept. */
  key: string | null
  resync: boolean
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
  private written = 0
  private acked = 0
  /** Stream bytes waiting or not acknowledged. */
  private streamBytes = 0
  private paceMs = 0
  private lastPatches = Number.NEGATIVE_INFINITY
  private paceTimer: ReturnType<typeof setTimeout> | null = null
  private overflowAt: number
  private readonly drains = new Set<() => void>()
  private closed = false

  constructor(private readonly options: OutboxOptions) {
    this.limits = { ...OUTBOX_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
    this.overflowAt = this.limits.queued
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
  }

  /** Sends a message after every one before it; rejects when it cannot go, as when too long. */
  push(message: ChannelMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The device session ended'))
    if (!this.options.acks) {
      const connection = this.connection
      if (!connection) return Promise.reject(new Error('The device is not connected'))
      return connection.channel.send(message)
    }
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
    this.enqueue(entryOf(message, size))
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
      if (entry.stream) {
        this.streamBytes -= entry.size
        freed = true
      }
    }
    this.unacked = this.unacked.slice(done)
    if (freed) this.wake()
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

  /** The session ended: nothing more is sent, and what waited goes. */
  close(): void {
    this.closed = true
    this.detach()
    this.queued = []
    this.unacked = []
    this.queuedOther = 0
    this.streamBytes = 0
    this.wake()
  }

  private enqueue(entry: Entry): void {
    if (entry.batch && this.merge(entry.batch, entry.size)) return this.pump()
    this.queued.push(entry)
    if (!entry.batch) this.queuedOther++
    if (entry.stream) this.streamBytes += entry.size
    if (this.queued.length > this.overflowAt) this.overflow()
    if (this.queued.length + this.unacked.length > this.limits.kept) {
      return this.options.overflowed()
    }
    this.pump()
  }

  /**
   * Adds a batch to the waiting one of its session it follows, when only patches wait after that
   * one, so nothing else changes places with it.
   */
  private merge(batch: Batch, size: number): boolean {
    for (let i = this.queued.length - 1; i >= 0; i--) {
      const waiting = this.queued[i]!
      if (!waiting.batch) return false
      if (waiting.batch.sessionId !== batch.sessionId) continue
      if (waiting.batch.seq + 1 !== batch.from) return false
      if (waiting.size + size > this.limits.mergedBytes) return false
      waiting.batch.seq = batch.seq
      for (const patch of batch.patches) waiting.batch.patches.push(patch)
      waiting.size += size
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
      kept.push({ ...entryOf({ kind: 'json', value: resync }, size), resync: true })
    }
    this.queuedOther = kept.length
    if (dropped > 0) this.options.dropped(dropped)
    // What is left stays until the device reads it, so the next look waits for twice as much.
    this.overflowAt = Math.max(this.limits.queued, this.queued.length * 2)
  }

  private pump(): void {
    const connection = this.connection
    if (!connection || this.closed || !this.options.acks) return
    while (this.queued.length > 0 && this.unacked.length < this.limits.inFlight) {
      if (this.queuedOther === 0 && this.paceMs > 0) {
        const due = this.lastPatches + this.paceMs - this.now()
        if (due > 0) return this.schedulePace(due)
      }
      const entry = this.queued.shift()!
      if (entry.batch) this.lastPatches = this.now()
      else this.queuedOther--
      entry.message = finished(entry)
      entry.seq = ++this.written
      this.unacked.push(entry)
      this.transmit(connection, entry)
    }
    if (this.queued.length <= this.limits.queued) this.overflowAt = this.limits.queued
  }

  private transmit(connection: OutboxConnection, entry: Entry): void {
    // A channel fails only as its connection ends, and the entry waits for the next one.
    connection.channel.send(entry.message).catch(() => {})
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

  private wake(): void {
    const drains = [...this.drains]
    this.drains.clear()
    for (const resolve of drains) resolve()
  }
}

function entryOf(message: ChannelMessage, size: number): Entry {
  const value = message.kind === 'json' ? message.value : null
  return {
    message,
    size,
    stream: message.kind === 'bytes',
    seq: 0,
    batch: batchOf(value),
    key: stateKey(value),
    resync: false,
  }
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
  'usage.changed',
  'usage.status',
  'artifacts.changed',
  'remote.changed',
  'sharing.changed',
  'updates.changed',
  'themes.changed',
])

function idKey(kind: string, id: unknown): string | null {
  return typeof id === 'string' ? `${kind}:${id}` : null
}

/** What a message says the whole of, when the newest one makes the ones before it worthless. */
function stateKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const { type, event } = value as { type?: unknown; event?: unknown }
  if (type === 'addresses' || type === 'terminal' || type === 'renamed') return type
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
    case 'artifacts.version':
    case 'artifacts.activity':
      return idKey(kind, fields.id)
    case 'routine.changed':
      return idKey('routine', of('routine').id)
    case 'routine.removed':
      return idKey('routine', fields.routineId)
    case 'routine.run':
      return idKey('routine.run', of('run').id)
    default:
      return typeof kind === 'string' && WHOLE_STATES.has(kind) ? kind : null
  }
}
