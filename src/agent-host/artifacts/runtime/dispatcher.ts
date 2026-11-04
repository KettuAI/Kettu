// The one place a page's request to the runtime is checked: what the artifact's latest version
// declares, what the user allowed, how large and how frequent its requests are. The clients only
// pass the message on, with the artifact they found it came from.

import {
  errorAnswer,
  messageHeader,
  parseRuntimeMessage,
  RUNTIME_MESSAGE_BYTES,
  RUNTIME_VERSIONS,
  type RuntimeAnswer,
  type RuntimeErrorCode,
} from '@shared/artifact-capabilities'
import type { LogFn } from '../../storage'
import type { DeclaredArtifact } from './calls'

/** What a handler is told of the request it serves. */
export interface CapabilityContext {
  artifactId: string
  /** The artifact's project folder; null for one under No project. */
  project: string | null
  /** The artifact's latest version, whose declaration the request was checked against. */
  version: number
  declared: readonly string[]
  /** Who relayed it: `desktop` for the app's own windows, else the paired device's port. */
  client: string
  /** Aborts when the page cancels, or its client goes. */
  signal: AbortSignal
}

export interface CapabilityHandler {
  name: string
  /** The user allows it per artifact before a page may use it. */
  consent: boolean
  ops: readonly string[]
  call(ctx: CapabilityContext, op: string, args: unknown): Promise<unknown>
  stream?(
    ctx: CapabilityContext,
    op: string,
    args: unknown,
    emit: (event: unknown) => void,
  ): Promise<void>
  /** Whether a page may use it here at all, before any consent; `use` answers null when not. */
  available?(ctx: CapabilityContext): Promise<boolean> | boolean
}

/** A refusal a handler throws, which the page gets as its error. */
export class CapabilityError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CapabilityError'
  }
}

/** The client of the host's own windows, which main relays for; a device's is its port. */
export const DESKTOP_CLIENT = 'desktop'

const registry = new Map<string, CapabilityHandler>()

/** Adds a capability, or replaces the one of its name. */
export function registerCapability(handler: CapabilityHandler): void {
  registry.set(handler.name, handler)
}

/** Requests an artifact's pages may make at once, besides its streams. */
export const MAX_IN_FLIGHT = 32
export const MAX_STREAMS = 16
/** Requests an artifact's pages may make in a burst, and how many a second come back. */
export const BURST = 120
export const PER_SECOND = 30
/**
 * How long `use` waits for the user's consent. Under the 10 s after which the page takes no
 * answer as null, so the answer still reaches it.
 */
export const CONSENT_WAIT_MS = 9_000

export type ConsentOutcome = 'allowed' | 'denied' | 'waiting'

export interface DispatcherDeps {
  /** The artifact and its latest version's declaration, or null when there is none. */
  artifact(id: string): Promise<DeclaredArtifact | null>
  /** The folder as a project, or null for a scratch folder. */
  project(folder: string): string | null
  /** Whether the user allowed the artifact the capability. */
  allowed(artifactId: string, capability: string): Promise<boolean>
  /**
   * Asks the client's user for the capability, outside the page; `waiting` when no answer came
   * within `waitMs`, which leaves the question open.
   */
  ask(
    artifact: DeclaredArtifact,
    capability: string,
    client: string,
    waitMs: number,
  ): Promise<ConsentOutcome>
  log: LogFn
  now?: () => number
  /** The capabilities answered; the registered ones by default. */
  handlers?: ReadonlyMap<string, CapabilityHandler>
}

export interface DispatchInput {
  artifactId: string
  message: unknown
  client: string
  signal: AbortSignal
  /** A stream's events; its end is the answer `dispatch` resolves with. */
  emit(answer: RuntimeAnswer): void
}

interface Budget {
  tokens: number
  at: number
  inFlight: number
  streams: number
}

function messageBytes(message: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(message) ?? '', 'utf8')
  } catch {
    return Infinity
  }
}

export class RuntimeDispatcher {
  private readonly budgets = new Map<string, Budget>()

  constructor(private readonly deps: DispatcherDeps) {}

  private get handlers(): ReadonlyMap<string, CapabilityHandler> {
    return this.deps.handlers ?? registry
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Takes a request from the artifact's budget; false when it has spent it. */
  private spend(artifactId: string): boolean {
    const now = this.now()
    let budget = this.budgets.get(artifactId)
    if (!budget) {
      budget = { tokens: BURST, at: now, inFlight: 0, streams: 0 }
      this.budgets.set(artifactId, budget)
    }
    budget.tokens = Math.min(BURST, budget.tokens + ((now - budget.at) / 1000) * PER_SECOND)
    budget.at = now
    if (budget.tokens < 1) return false
    budget.tokens -= 1
    return true
  }

  private budget(artifactId: string): Budget {
    return this.budgets.get(artifactId)!
  }

  /** Answers one message of a page of `artifactId`; a stream's events go to `emit` first. */
  async dispatch(input: DispatchInput): Promise<RuntimeAnswer> {
    const header = messageHeader(input.message)
    const message = parseRuntimeMessage(input.message)
    if (!message) return errorAnswer(header, 'invalid', 'The message is not one the runtime reads.')
    const { v, id } = message
    // A use answers null for every refusal, so a page cannot tell them apart.
    const none: RuntimeAnswer = { v, id, ok: true, value: null }
    const refuse = (code: RuntimeErrorCode, text: string): RuntimeAnswer =>
      message.kind === 'use' ? none : errorAnswer(message, code, text)
    if (!RUNTIME_VERSIONS.includes(v)) {
      return refuse('unsupported', `This Kettu does not answer version ${v} of the runtime.`)
    }
    if (message.kind === 'cancel') return { v, id, ok: true, value: null }
    if (messageBytes(input.message) > RUNTIME_MESSAGE_BYTES) {
      return refuse('too_large', 'The message is too large.')
    }
    if (!this.spend(input.artifactId)) {
      return refuse('rate_limited', 'Too many requests; wait a moment.')
    }
    const artifact = await this.deps.artifact(input.artifactId).catch((error: unknown) => {
      this.deps.log('warn', `The runtime could not read ${input.artifactId}: ${String(error)}`)
      return null
    })
    if (!artifact || artifact.deleted) return refuse('not_found', 'The artifact is not there.')
    const handler = this.handlers.get(message.cap)
    if (!handler) return refuse('unsupported', `Kettu has no capability ${message.cap}.`)
    if (!artifact.capabilities.includes(message.cap)) {
      return refuse('not_declared', `The artifact does not declare ${message.cap}.`)
    }
    const ctx: CapabilityContext = {
      artifactId: artifact.id,
      project: this.deps.project(artifact.project),
      version: artifact.head,
      declared: artifact.capabilities,
      client: input.client,
      signal: input.signal,
    }
    try {
      if (handler.available && !(await handler.available(ctx))) {
        return refuse('unsupported', `${message.cap} is not available here.`)
      }
    } catch (error) {
      this.deps.log(
        'warn',
        `${message.cap} could not tell whether it is available: ${String(error)}`,
      )
      return refuse('failed', `${message.cap} failed.`)
    }
    if (handler.consent && !(await this.deps.allowed(artifact.id, message.cap))) {
      if (message.kind !== 'use') {
        return errorAnswer(message, 'not_allowed', `The user has not allowed ${message.cap}.`)
      }
      const outcome = await this.deps.ask(artifact, message.cap, input.client, CONSENT_WAIT_MS)
      if (outcome !== 'allowed') return none
    }
    if (message.kind === 'use') return { v, id, ok: true, value: { ops: [...handler.ops] } }
    if (!handler.ops.includes(message.op)) {
      return errorAnswer(message, 'unsupported', `${message.cap} has no ${message.op}.`)
    }
    const budget = this.budget(input.artifactId)
    if (message.kind === 'stream') {
      if (!handler.stream) {
        return errorAnswer(message, 'unsupported', `${message.cap}.${message.op} does not stream.`)
      }
      if (budget.streams >= MAX_STREAMS) {
        return errorAnswer(message, 'rate_limited', 'Too many open streams; close one first.')
      }
      budget.streams += 1
      try {
        await handler.stream(ctx, message.op, message.args, (event) => {
          if (!input.signal.aborted) input.emit({ v, id, event })
        })
        return { v, id, done: true }
      } catch (error) {
        return this.failure(message, error)
      } finally {
        budget.streams -= 1
      }
    }
    if (budget.inFlight >= MAX_IN_FLIGHT) {
      return errorAnswer(message, 'rate_limited', 'Too many requests at once; wait for some.')
    }
    budget.inFlight += 1
    try {
      const value = await handler.call(ctx, message.op, message.args)
      return { v, id, ok: true, value: value ?? null }
    } catch (error) {
      return this.failure(message, error)
    } finally {
      budget.inFlight -= 1
    }
  }

  private failure(
    message: { v: number; id: string; cap?: string; op?: string },
    error: unknown,
  ): RuntimeAnswer {
    if (error instanceof CapabilityError) return errorAnswer(message, error.code, error.message)
    this.deps.log(
      'error',
      `${message.cap}.${message.op} failed: ${(error as Error)?.stack ?? String(error)}`,
    )
    return errorAnswer(message, 'failed', `${message.cap}.${message.op} failed.`)
  }
}

/**
 * The requests in flight of each client, so a cancel or a client that goes aborts them: main's by
 * its request id, a device port's streams by the name it gave them.
 */
export class RuntimeRequests {
  private readonly open = new Map<string, AbortController>()
  private calls = 0

  constructor(private readonly dispatcher: RuntimeDispatcher) {}

  private run(
    key: string,
    artifactId: string,
    message: unknown,
    client: string,
    emit: (answer: RuntimeAnswer) => void,
  ): Promise<RuntimeAnswer> {
    this.open.get(key)?.abort()
    const controller = new AbortController()
    this.open.set(key, controller)
    return this.dispatcher
      .dispatch({ artifactId, message, client, signal: controller.signal, emit })
      .finally(() => {
        if (this.open.get(key) === controller) this.open.delete(key)
      })
  }

  /** A request main relayed from a window's frame; every answer goes to `send`, the last too. */
  fromMain(
    requestId: number,
    artifactId: string,
    message: unknown,
    send: (answer: RuntimeAnswer) => void,
  ): void {
    const key = `${DESKTOP_CLIENT}\0${requestId}`
    void this.run(key, artifactId, message, DESKTOP_CLIENT, send).then(send)
  }

  cancelMain(requestId: number): void {
    this.open.get(`${DESKTOP_CLIENT}\0${requestId}`)?.abort()
  }

  /**
   * A request a device's remote host relayed from one of its frames. A stream, and the cancel
   * that ends it, name it by `stream`, the port's own name for it.
   */
  fromPort(
    portId: string,
    artifactId: string,
    message: unknown,
    stream: string | undefined,
    emit: (answer: RuntimeAnswer) => void,
  ): Promise<RuntimeAnswer> {
    const kind = (message as { kind?: unknown } | null)?.kind
    const key = stream === undefined ? undefined : `${portId}\0${stream}`
    if (kind === 'cancel') {
      if (key) this.open.get(key)?.abort()
      return this.dispatcher.dispatch({
        artifactId,
        message,
        client: portId,
        signal: AbortSignal.abort(),
        emit,
      })
    }
    const named = key ?? `${portId}\0call\0${++this.calls}`
    return this.run(named, artifactId, message, portId, emit)
  }

  /** The port closed: its requests end, and their answers go nowhere. */
  portClosed(portId: string): void {
    for (const [key, controller] of [...this.open]) {
      if (key.startsWith(`${portId}\0`)) controller.abort()
    }
  }

  /** Main went: every request it relayed ends. */
  mainGone(): void {
    this.portClosed(DESKTOP_CLIENT)
  }
}
