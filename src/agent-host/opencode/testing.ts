// What the OpenCode tests share: the events OpenCode 2.3.2's server sent, recorded with paths and
// names replaced, a scripted server, and a thread that takes a mapper's output as a session does.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import type { PermissionAnswer, PermissionRequest, SessionTarget } from '../connection'
import {
  newTurnScope,
  type MapperContext,
  type MapperEffect,
  type MapperOutput,
} from '../session-updates'
import { sessionOf, type MessageInfo, type ServerEvent } from './protocol'
import type { ServerApi } from './server'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

/** The folder the recorded sessions ran in. */
export const CWD = '/work/app'

/** A recorded stream, in the order the server sent it. */
export function recorded(name: string): ServerEvent[] {
  return readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ServerEvent)
}

/** The stored messages of a recorded session, oldest first. */
export function storedMessages(name: 'tools' | 'compact'): MessageInfo[] {
  const all = JSON.parse(readFileSync(path.join(FIXTURES, 'messages.json'), 'utf8')) as Record<
    string,
    MessageInfo[]
  >
  return all[name]!
}

/** The session a recorded stream opens with: the one Kettu made. */
export function rootOf(events: readonly ServerEvent[]): string {
  const made = events.find(
    (event) => event.type === 'session.created' && !(event.data as { parentID?: string }).parentID,
  )
  return made ? sessionOf(made)! : sessionOf(events[0]!)!
}

export class TestThread implements SessionTarget {
  state: ThreadState
  readonly effects: MapperEffect[] = []
  readonly asked: PermissionRequest[] = []
  readonly scope = newTurnScope()
  /** What the user answers a card with; a promise leaves it open until it settles. */
  answer: (request: PermissionRequest) => PermissionAnswer | Promise<PermissionAnswer> = () =>
    'cancelled'
  replaying = false
  cancelling = false
  now = 1_000
  private ids = 0

  constructor(id = 's') {
    this.state = threadFromSnapshot({
      session: {
        id,
        agentId: 'opencode',
        projectPath: CWD,
        acpSessionId: id,
        status: 'running',
        title: null,
        config: [],
        commands: [],
        usage: null,
        error: null,
        turnStartedAt: null,
        turnStartUsed: null,
        createdAt: 0,
        updatedAt: 0,
        parentId: null,
        origin: 'user',
        subagent: null,
        routine: null,
        queue: [],
        queuePaused: false,
      },
      entries: [],
      seq: 0,
    })
  }

  context(): MapperContext {
    return {
      thread: this.state,
      replaying: this.replaying,
      cancelling: this.cancelling,
      scope: this.scope,
      now: this.now++,
      nextId: () => `e:${++this.ids}`,
      sessionIdFor: () => null,
    }
  }

  apply(output: MapperOutput): void {
    this.state = applyPatches(this.state, output.patches)
    this.effects.push(...output.effects)
  }

  async requestPermission(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionAnswer> {
    this.apply(request.output)
    this.asked.push(request)
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
      void Promise.resolve(this.answer(request)).then(resolve, reject)
    })
  }

  send(): void {}

  startMode(): string | null {
    return null
  }

  get entries(): ThreadEntry[] {
    return threadEntries(this.state)
  }

  /** Each entry as one line: its kind, state and what it says. */
  get lines(): string[] {
    return this.entries.map((entry) => {
      switch (entry.kind) {
        case 'user':
          return `user ${entry.content.map((part) => (part.type === 'text' ? part.text : part.ref.kind)).join(' ')}`
        case 'agent':
          return `agent${entry.streaming ? ' streaming' : ''} ${entry.markdown}`
        case 'thought':
          return `thought${entry.streaming ? ' streaming' : ''} ${entry.markdown}`
        case 'tool':
          return `tool ${entry.status} ${entry.toolKind} ${entry.title}`
        case 'compaction':
          return `compaction ${entry.status}`
        default:
          return entry.kind
      }
    })
  }

  tool(callId: string): Extract<ThreadEntry, { kind: 'tool' }> | null {
    const entry = this.state.byId[`t:${callId}`]
    return entry?.kind === 'tool' ? entry : null
  }
}

/** The model the scripted server names as the default. */
export const MODEL = { id: 'deepseek-flash', providerID: 'deepseek' }

export interface Sent {
  method: string
  path: string
  body: unknown
}

export type Route = (sent: Sent) => unknown

/** A scripted server: it answers by the first route that matches, and sends what a test pushes. */
export class FakeServer {
  readonly sent: Sent[] = []
  streams = 0
  private readonly routes: { method: string; path: RegExp; answer: Route }[] = []
  private emit: ((event: ServerEvent) => void) | null = null
  private end: (() => void) | null = null
  private sessions = 0

  constructor() {
    this.on('GET', /^\/api\/model\/default/, () => ({ data: MODEL }))
    this.on('GET', /^\/api\/model\?/, () => ({
      data: [
        {
          ...MODEL,
          name: 'DeepSeek Flash',
          variants: [{ id: 'low' }, { id: 'high' }],
          limit: { context: 1000 },
          settings: { apiKey: 'sk-never-kept' },
        },
        { id: 'gpt', providerID: 'openai', name: 'GPT', variants: [{ id: 'high' }] },
      ],
    }))
    this.on('GET', /^\/api\/agent\?/, () => ({
      data: [
        { id: 'build', name: 'Build', mode: 'primary' },
        { id: 'plan', name: 'Plan', mode: 'primary', description: 'Read-only' },
        { id: 'title', name: 'Title', mode: 'primary', hidden: true },
        { id: 'explore', name: 'Explore', mode: 'subagent' },
      ],
    }))
    this.on('GET', /^\/api\/command\?/, () => ({
      data: [{ name: 'review', description: 'review' }],
    }))
    this.on('POST', /^\/api\/session$/, () => ({ data: this.info(`ses_${++this.sessions}`) }))
    this.on('GET', /^\/api\/session\/active$/, () => ({ data: {} }))
    this.on('GET', /^\/api\/session\/[^/]+$/, ({ path }) => ({
      data: this.info(path.split('/')[3]!),
    }))
    this.on('GET', /\/instructions\/entries$/, () => ({ data: [] }))
    this.on('GET', /\/(permission|form|inbox)$/, () => ({ data: [] }))
    this.on('GET', /\/message\?/, () => ({ data: [], cursor: {} }))
    this.on('POST', /\/interrupt$/, () => ({ interrupted: true }))
  }

  info(id: string): Record<string, unknown> {
    return { id, time: { created: 1, updated: 2 }, location: { directory: CWD }, title: 'T' }
  }

  /** Answers a request, ahead of the routes set before. */
  on(method: string, path: RegExp, answer: Route): void {
    this.routes.unshift({ method, path, answer })
  }

  readonly api: ServerApi = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const sent = { method, path, body }
      this.sent.push(sent)
      const route = this.routes.find((item) => item.method === method && item.path.test(path))
      return (route ? route.answer(sent) : undefined) as T
    },
    events: (onEvent, signal) =>
      new Promise<void>((resolve) => {
        this.streams++
        this.emit = onEvent
        this.end = resolve
        signal.addEventListener('abort', () => resolve(), { once: true })
        queueMicrotask(() => onEvent({ type: 'server.connected', data: {} }))
      }),
  }

  push(...events: ServerEvent[]): void {
    for (const event of events) this.emit?.(event)
  }

  /** Ends the stream, as a server that dropped it does. */
  drop(): void {
    this.emit = null
    this.end?.()
  }

  posts(path: RegExp): Sent[] {
    return this.sent.filter((sent) => sent.method !== 'GET' && path.test(sent.path))
  }
}
