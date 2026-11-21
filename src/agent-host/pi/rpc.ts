// Commands to one `pi --mode rpc` process and what it sends back: each command carries an id its
// response repeats, and every other record is an event of the session.

import type { Readable, Writable } from 'node:stream'
import { t } from '../i18n'
import { jsonLineWriter, readJsonLines, type JsonLineWriter } from './jsonl'
import type { PiEvent, PiResponse, PiUiAnswer } from './protocol'

/** A command pi answered with `success: false`. */
export class PiCommandError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message)
    this.name = 'PiCommandError'
  }
}

/** The process went before the answer came. */
export class PiClosed extends Error {
  constructor() {
    super('The pi process closed its connection')
    this.name = 'PiClosed'
  }
}

export interface PiRpcHandlers {
  event(event: PiEvent): void
  traffic(direction: 'in' | 'out', message: unknown): void
  /** A line of stdout that is no record, which pi keeps for stderr since 0.61.0. */
  garbage(line: string): void
}

interface Pending {
  command: string
  resolve(data: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class PiRpc {
  /** Settles once the process's stdout ended. */
  readonly closed: Promise<void>
  private readonly writer: JsonLineWriter
  private readonly pending = new Map<string, Pending>()
  private nextId = 1
  private ended = false

  constructor(
    stdin: Writable,
    stdout: Readable,
    private readonly handlers: PiRpcHandlers,
  ) {
    this.writer = jsonLineWriter(stdin)
    this.closed = readJsonLines(stdout, {
      record: (value) => this.take(value),
      garbage: (line) => handlers.garbage(line),
    }).then(() => this.finish())
  }

  get isClosed(): boolean {
    return this.ended
  }

  /**
   * Sends a command and resolves with its response's `data`. Rejects with `PiCommandError` when pi
   * refuses it, `PiClosed` when the process goes first, and after `timeoutMs` when one is given.
   */
  request<T = unknown>(
    command: { type: string } & Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.ended) return Promise.reject(new PiClosed())
    const id = `k${this.nextId++}`
    const record = { id, ...command }
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        command: command.type,
        resolve: (data) => resolve(data as T),
        reject,
        timer: null,
      }
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          reject(new Error(t('pi.noAnswer', { command: command.type, seconds: timeoutMs / 1000 })))
        }, timeoutMs)
        pending.timer.unref?.()
      }
      this.pending.set(id, pending)
      this.handlers.traffic('out', record)
      this.writer.write(record).catch(() => {
        if (!this.pending.delete(id)) return
        if (pending.timer) clearTimeout(pending.timer)
        reject(new PiClosed())
      })
    })
  }

  /** Answers an extension's dialog, which pi takes without a response of its own. */
  answer(id: string, answer: PiUiAnswer): void {
    if (this.ended) return
    const record = { type: 'extension_ui_response', id, ...answer }
    this.handlers.traffic('out', record)
    this.writer.write(record).catch(() => {})
  }

  /** Closes pi's stdin, which asks it for an orderly shutdown. */
  end(): void {
    this.writer.end()
  }

  private take(value: unknown): void {
    this.handlers.traffic('in', value)
    if (!isRecord(value) || typeof value.type !== 'string') return
    if (value.type !== 'response') {
      this.handlers.event(value as unknown as PiEvent)
      return
    }
    const response = value as unknown as PiResponse
    const pending = typeof response.id === 'string' ? this.pending.get(response.id) : undefined
    if (!pending) return
    this.pending.delete(response.id!)
    if (pending.timer) clearTimeout(pending.timer)
    if (response.success) pending.resolve(response.data)
    else {
      pending.reject(new PiCommandError(pending.command, response.error ?? t('pi.refused')))
    }
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new PiClosed())
    }
    this.pending.clear()
  }
}
