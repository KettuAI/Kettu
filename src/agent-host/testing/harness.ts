// Test helpers: the fake agent in-process, a renderer port, and a whole host in a temp dir.

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentApp } from '@agentclientprotocol/sdk/unstable'
import type {
  HostEvent,
  HostMethod,
  HostParams,
  HostResult,
  SessionSummary,
} from '@shared/agent-host'
import type { HostToMain } from '@shared/host-control'
import { PortRequestError, type FromPort } from '@shared/port-rpc'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import {
  applyPatches,
  threadEntries,
  threadFromSnapshot,
  type SessionSnapshot,
  type ThreadEntry,
  type ThreadState,
} from '@shared/thread'
import { inProcessTransport } from '../acp/connection'
import type { ExitInfo } from '../agent-process'
import type { AgentLauncher, AgentTimings } from '../agents'
import { detectAgent } from '../catalog'
import type { Env } from '../find-command'
import type { GitServiceApi } from '../git/api'
import { AgentHost, type HostOptions } from '../host'
import type { ProcessControl } from '../process-tree'
import type { CacheTtlReader } from '../prompt-cache'
import type { PortChannel } from '../rpc'
import type { SessionTimings } from '../sessions'
import type { LogReader } from '../usage/model'
import { inThreadWorker } from './thread-worker'
import { inUsageWorker } from './usage-worker'

export const FAKE_AGENT_MAIN = path.resolve('tools/fake-agent/main.ts')

export interface FakeAgentModule {
  createFakeAgent(options: {
    env?: Env
    exit?: (code: number) => void
    log?: (line: string) => void
  }): AgentApp
}

let fakeAgentModule: Promise<FakeAgentModule> | null = null

/**
 * The fake agent's own module. It is imported by URL because its `.ts` import specifiers,
 * which Node.js needs to run it directly, are outside this project's TypeScript settings.
 */
export function loadFakeAgent(): Promise<FakeAgentModule> {
  const url = pathToFileURL(path.resolve('tools/fake-agent/agent.ts')).href
  fakeAgentModule ??= import(/* @vite-ignore */ url) as Promise<FakeAgentModule>
  return fakeAgentModule
}

export interface InProcessLauncher extends AgentLauncher {
  launches: number
  /** Ends the current agent as a crash would. */
  crash(code?: number): void
}

/** Runs the fake agent inside the test process, connected through an in-memory stream. */
export function inProcessLauncher(module: FakeAgentModule, env: Env = {}): InProcessLauncher {
  let current: ((info: ExitInfo) => void) | null = null
  const launcher: InProcessLauncher = {
    launches: 0,
    crash: (code = 3) => current?.({ code, signal: null }),
    launch: (_def, spec, baseEnv, output) => {
      launcher.launches++
      let resolveExit!: (info: ExitInfo) => void
      const exited = new Promise<ExitInfo>((resolve) => (resolveExit = resolve))
      let done = false
      const finish = (info: ExitInfo): void => {
        if (done) return
        done = true
        transport.close()
        resolveExit(info)
      }
      current = finish
      const app = module.createFakeAgent({
        env: { ...baseEnv, ...spec.env, FAKE_AGENT_DELAY_SCALE: '0', ...env },
        // Like process.exit, the agent's code after exit() never gets to answer.
        exit: (code) => setTimeout(() => finish({ code, signal: null }), 0),
        log: (line) => output.stderr(`${line}\n`),
      })
      const transport = inProcessTransport(app)
      return {
        pid: null,
        startedAt: Date.now(),
        transport,
        exited,
        get hasExited() {
          return done
        },
        stop: async () => {
          finish({ code: 0, signal: null })
          return exited
        },
      }
    },
  }
  return launcher
}

type Waiter = { check: () => boolean; resolve: () => void }

/** A renderer port: requests with `request`, events in `events`, replicas of watched threads. */
export class TestPort implements PortChannel {
  readonly events: HostEvent[] = []
  readonly replicas = new Map<string, { thread: ThreadState; seq: number; batches: number }>()
  private listener: ((data: unknown) => void) | null = null
  private closeListener: (() => void) | null = null
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly waiters = new Set<Waiter>()
  private counter = 0
  closed = false

  send(message: FromPort<HostEvent>): void {
    // A real port clones every message; this catches values that would not survive it.
    const copy = structuredClone(message)
    if (copy.type === 'event') {
      this.events.push(copy.event)
      if (copy.event.type === 'session.patches') this.applyBatch(copy.event.batch)
    } else {
      const request = this.pending.get(copy.id)
      this.pending.delete(copy.id)
      if (copy.type === 'response') request?.resolve(copy.result)
      else request?.reject(new PortRequestError(copy.error))
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.check()) {
        this.waiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  private applyBatch(batch: { sessionId: string; seq: number; patches: unknown[] }): void {
    const replica = this.replicas.get(batch.sessionId)
    if (!replica) return
    if (batch.seq <= replica.seq) return
    if (batch.seq !== replica.seq + 1) {
      throw new Error(`Gap in ${batch.sessionId}: seq ${batch.seq} after ${replica.seq}`)
    }
    replica.thread = applyPatches(replica.thread, batch.patches as never)
    replica.seq = batch.seq
    replica.batches++
  }

  onMessage(listener: (data: unknown) => void): void {
    this.listener = listener
  }

  onClose(listener: () => void): void {
    this.closeListener = listener
  }

  close(): void {
    this.closed = true
  }

  /** The page went away. */
  disconnect(): void {
    this.closeListener?.()
  }

  post(data: unknown): void {
    this.listener?.(structuredClone(data))
  }

  request<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>> {
    const id = ++this.counter
    return new Promise<HostResult<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.post({ type: 'request', id, method, params })
    })
  }

  /** Opens, watches and shows a session the way the renderer does, keeping a replica of it. */
  async open(sessionId: string): Promise<SessionSnapshot> {
    await this.request('sessions.watch', { sessionId })
    await this.request('sessions.show', { sessionId })
    const snapshot = await this.request('sessions.open', { sessionId })
    this.track(snapshot)
    return snapshot
  }

  track(snapshot: SessionSnapshot): void {
    this.replicas.set(snapshot.session.id, {
      thread: threadFromSnapshot(snapshot),
      seq: snapshot.seq,
      batches: 0,
    })
  }

  thread(sessionId: string): ThreadState {
    const replica = this.replicas.get(sessionId)
    if (!replica) throw new Error(`No replica for ${sessionId}`)
    return replica.thread
  }

  entries(sessionId: string): ThreadEntry[] {
    return threadEntries(this.thread(sessionId))
  }

  /** The latest summary this port received for a session. */
  summary(sessionId: string): SessionSummary | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i]!
      if (event.type === 'session.summary' && event.summary.id === sessionId) return event.summary
    }
    return undefined
  }

  until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
    if (check()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { check, resolve: () => (clearTimeout(timer), resolve()) }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`Timed out waiting: ${check.toString()}`))
      }, timeoutMs)
      this.waiters.add(waiter)
    })
  }

  untilStatus(sessionId: string, ...statuses: string[]): Promise<void> {
    return this.until(() => statuses.includes(this.summary(sessionId)?.status ?? ''))
  }

  untilEntry(sessionId: string, check: (entry: ThreadEntry) => boolean): Promise<void> {
    return this.until(() => this.replicas.has(sessionId) && this.entries(sessionId).some(check))
  }
}

export interface TestHostOptions {
  userDataPath?: string
  agentEnv?: Env
  settings?: HostSettings
  git?: GitServiceApi | null
  agentTimings?: Partial<AgentTimings>
  sessionTimings?: Partial<SessionTimings>
  treeNoteMs?: number
  processControl?: ProcessControl
  launcher?: AgentLauncher
  projectDir?: string
  resolveEnv?: HostOptions['resolveEnv']
  /** Log readers for Usage on this computer, read by both the manager and the worker. */
  usageReaders?: readonly LogReader[]
  cacheTtl?: CacheTtlReader
}

export interface TestHost {
  host: AgentHost
  launcher: InProcessLauncher | AgentLauncher
  sent: HostToMain[]
  dir: string
  project: string
  connect(): TestPort
  stop(): Promise<void>
}

/** A whole agent host on a temp data directory, with the fake agent and no other agent found. */
export async function startTestHost(options: TestHostOptions = {}): Promise<TestHost> {
  const dir = options.userDataPath ?? (await mkdtemp(path.join(os.tmpdir(), 'overbench-host-')))
  const project = options.projectDir ?? path.join(dir, 'project')
  await mkdir(project, { recursive: true })
  const module = await loadFakeAgent()
  const launcher = options.launcher ?? inProcessLauncher(module, options.agentEnv)
  const sent: HostToMain[] = []
  const host = await AgentHost.start({
    userDataPath: dir,
    appVersion: '0.0.0-test',
    platform: process.platform,
    electronPath: process.execPath,
    fakeAgentPath: FAKE_AGENT_MAIN,
    settings: options.settings ?? {
      locale: 'en',
      agents: DEFAULT_SETTINGS.agents,
      proxy: DEFAULT_SETTINGS.proxy,
      git: DEFAULT_SETTINGS.git,
      usage: { fromComputer: false },
    },
    baseEnv: { ...process.env, ...options.agentEnv },
    send: (message) => sent.push(structuredClone(message)),
    git: options.git ?? null,
    launcher,
    resolveEnv:
      options.resolveEnv ??
      (async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      })),
    // No Node.js is found, so only the fake agent is available.
    probeNode: async () => ({ nodeVersion: null, npmPath: null, nodePath: null }),
    detect: async (def, ctx) => {
      if (def.id !== 'fake-agent') {
        return { state: 'not-installed', detail: `${def.name} is not part of the tests` }
      }
      return detectAgent(def, ctx)
    },
    agentTimings: options.agentTimings ?? {},
    sessionTimings: options.sessionTimings ?? {},
    ...(options.treeNoteMs !== undefined ? { treeNoteMs: options.treeNoteMs } : {}),
    ...(options.processControl ? { processControl: options.processControl } : {}),
    threadWorker: inThreadWorker,
    usageWorker: (file) => inUsageWorker(file, options.usageReaders),
    ...(options.usageReaders ? { usageReaders: options.usageReaders } : {}),
    ...(options.cacheTtl ? { cacheTtl: options.cacheTtl } : {}),
    homeDir: dir,
  })
  let stopped = false
  return {
    host,
    launcher,
    sent,
    dir,
    project: await realpath(project),
    connect: () => {
      const port = new TestPort()
      host.connect(port)
      return port
    },
    stop: async () => {
      if (stopped) return
      stopped = true
      await host.shutdown()
      if (!options.userDataPath) await rm(dir, { recursive: true, force: true })
    },
  }
}
