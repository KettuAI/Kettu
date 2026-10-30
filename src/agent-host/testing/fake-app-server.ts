// A scripted `codex app-server` for tests: a JSON-RPC peer in this process that records what it is
// asked, answers from handlers a test can replace, and sends notifications and requests of its own.

import type { MessageTransport } from '../driver'
import type { Model, ThreadItem, ThreadResponse, Turn } from '../codex/protocol'

type Handler = (params: Record<string, unknown>, server: FakeAppServer) => unknown

export interface RecordedRequest {
  method: string
  params: Record<string, unknown>
}

/** An error answer, which a handler throws to fail the request. */
export class FakeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export const FAKE_MODELS: Model[] = [
  {
    id: 'gpt-6.1-sol',
    displayName: 'gpt-6.1-sol',
    description: 'The default model',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Deep' },
    ],
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast'],
    serviceTiers: [{ id: 'priority', name: 'Fast' }],
    isDefault: true,
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'gpt-5.6-luna',
    description: 'A small model',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }],
    defaultReasoningEffort: 'low',
    additionalSpeedTiers: [],
    serviceTiers: [],
    isDefault: false,
  },
]

export function threadResponse(
  id: string,
  overrides: Partial<ThreadResponse> & { cwd?: string } = {},
): ThreadResponse {
  const { cwd = '/project', ...rest } = overrides
  return {
    thread: {
      id,
      parentThreadId: null,
      preview: '',
      ephemeral: false,
      historyMode: 'paginated',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'medium',
      createdAt: 1_800_000_000,
      updatedAt: 1_800_000_000,
      status: { type: 'idle' },
      cwd,
      agentNickname: null,
      agentRole: null,
      name: null,
      turns: [],
    },
    model: 'gpt-6.1-sol',
    modelProvider: 'openai',
    serviceTier: 'default',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    reasoningEffort: 'medium',
    ...rest,
  }
}

export function turn(
  id: string,
  status: Turn['status'] = 'inProgress',
  error: Turn['error'] = null,
): Turn {
  return { id, items: [], status, error }
}

export class FakeAppServer {
  readonly requests: RecordedRequest[] = []
  readonly transport: MessageTransport
  /** Items `thread/items/list` gives, by thread, each with its turn. */
  readonly history = new Map<string, { turnId: string; item: ThreadItem }[]>()
  private readonly handlers = new Map<string, Handler>()
  private readonly answers = new Map<number | string, (result: unknown) => void>()
  private readonly writer: WritableStreamDefaultWriter<unknown>
  private threads = 0
  private turns = 0
  private requestIds = 0
  closed = false

  constructor() {
    const toServer = new TransformStream<unknown, unknown>()
    const toClient = new TransformStream<unknown, unknown>()
    this.writer = toClient.writable.getWriter()
    this.transport = {
      kind: 'messages',
      stream: { readable: toClient.readable, writable: toServer.writable },
      close: () => this.close(),
    }
    void this.read(toServer.readable)
    this.defaults()
  }

  /** Replaces how a method is answered. */
  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler)
    return this
  }

  sent(method: string): Record<string, unknown>[] {
    return this.requests.filter((r) => r.method === method).map((r) => r.params)
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) void this.writer.write({ method, params })
  }

  /** A request of the server's; resolves with the client's answer. */
  request(method: string, params: unknown): { id: number; answer: Promise<unknown> } {
    const id = this.requestIds++
    const answer = new Promise<unknown>((resolve) => this.answers.set(id, resolve))
    void this.writer.write({ id, method, params })
    return { id, answer }
  }

  nextTurnId(): string {
    return `turn-${++this.turns}`
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    void this.writer.close().catch(() => {})
  }

  private async read(readable: ReadableStream<unknown>): Promise<void> {
    const reader = readable.getReader()
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
      if (done || this.closed) break
      void this.receive(value as Record<string, unknown>)
    }
    this.close()
  }

  private async receive(message: Record<string, unknown>): Promise<void> {
    const { id, method, params, result, error } = message as {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: unknown
    }
    if (method === undefined) {
      if (id !== undefined) this.answers.get(id)?.(error ? { error } : result)
      return
    }
    this.requests.push({ method, params: params ?? {} })
    if (id === undefined) return
    const handler = this.handlers.get(method)
    try {
      if (!handler) throw new FakeRpcError(-32601, `method not found: ${method}`)
      const answer = await handler(params ?? {}, this)
      if (!this.closed) await this.writer.write({ id, result: answer ?? {} })
    } catch (failure) {
      const code = failure instanceof FakeRpcError ? failure.code : -32603
      if (!this.closed) {
        await this.writer.write({ id, error: { code, message: (failure as Error).message } })
      }
    }
  }

  private defaults(): void {
    this.on('initialize', () => ({
      userAgent: 'Kettu/0.166.0 (Mac OS 27.0.1; arm64) unknown (Kettu; 0.0.0-test)',
      codexHome: '/home/.codex',
      platformFamily: 'unix',
      platformOs: 'macos',
    }))
    this.on('account/read', () => ({
      account: { type: 'chatgpt', email: 'developer@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    }))
    this.on('model/list', () => ({ data: FAKE_MODELS, nextCursor: null }))
    this.on('thread/start', (params) =>
      threadResponse(`thread-${++this.threads}`, {
        cwd: params.cwd as string,
        thread: {
          ...threadResponse('x').thread,
          id: `thread-${this.threads}`,
          ephemeral: !!params.ephemeral,
        },
      }),
    )
    this.on('thread/resume', (params) => threadResponse(params.threadId as string))
    this.on('thread/fork', () =>
      threadResponse(`thread-${++this.threads}`, {
        // A fork takes the configured model, not its source's.
        model: 'gpt-6.1-sol',
        reasoningEffort: 'high',
      }),
    )
    this.on('thread/items/list', (params) => ({
      data: this.history.get(params.threadId as string) ?? [],
      nextCursor: null,
    }))
    this.on('thread/list', () => ({ data: [], nextCursor: null }))
    this.on('thread/unsubscribe', () => ({ status: 'unsubscribed' }))
    this.on('thread/delete', () => ({}))
    this.on('turn/start', () => ({ turn: turn(this.nextTurnId()) }))
    this.on('turn/steer', (params) => ({ turnId: params.expectedTurnId }))
    this.on('turn/interrupt', () => ({}))
    this.on('account/rateLimits/read', () => ({
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 19, windowDurationMins: 300, resetsAt: 1_800_018_000 },
        secondary: { usedPercent: 32, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
      },
      rateLimitsByLimitId: null,
    }))
  }
}
