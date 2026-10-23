import { join } from 'node:path'
import { app, type WebContents } from 'electron'
import type { BusySession, HostToMain, MainToHost } from '@shared/host-control'
import type { HostSettings } from '@shared/settings'
import agentHostPath from '../agent-host/index?modulePath'
// The host's own bundle is built without electron-vite's worker plugin, so main builds this one.
import threadWorkerPath from '../agent-host/threads/worker?modulePath'
import usageWorkerPath from '../agent-host/usage/worker?modulePath'
import { processControl, stopTrees, type ProcessId } from '../agent-host/process-tree'
import { createLogger } from './log'
import { UtilityHost, type UtilityHostEvent, type UtilityHostState } from './utility-host'

const log = createLogger('agent-host')

export interface AgentHostDeps {
  settings(): HostSettings
  onAttention(message: Extract<HostToMain, { type: 'host:attention' }>): void
  onBadge(count: number): void
  onProjects(paths: string[]): void
  onAuthCommands(commands: string[]): void
}

const MAX_LIST = 10_000
const MAX_STRING = 8192
/** How long an agent's tree gets between SIGTERM and SIGKILL after its host died. */
const GRACE_MS = 2_000

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_STRING)
  )
}

function isBusySession(value: unknown): value is BusySession {
  if (typeof value !== 'object' || value === null) return false
  const { sessionId, agentId, title } = value as Record<string, unknown>
  return (
    typeof sessionId === 'string' &&
    typeof agentId === 'string' &&
    (title === null || typeof title === 'string')
  )
}

/** Main's side of the agent host: supervision, ports, and what the host asks main to do. */
export class AgentHost {
  private readonly host: UtilityHost<MainToHost, HostToMain>
  private agentProcesses: ProcessId[] = []
  private readonly busyRequests = new Map<number, (sessions: BusySession[]) => void>()
  private nextBusyId = 1

  constructor(private readonly deps: AgentHostDeps) {
    this.host = new UtilityHost<MainToHost, HostToMain>({
      label: 'agent-host',
      channel: 'agent-host',
      modulePath: agentHostPath,
      serviceName: 'OverBench Agent Host',
      initMessage: () => ({
        type: 'host:init',
        userDataPath: app.getPath('userData'),
        appVersion: app.getVersion(),
        platform: process.platform,
        isPackaged: app.isPackaged,
        electronPath: process.execPath,
        fakeAgentPath: app.isPackaged
          ? (process.env.OVERBENCH_FAKE_AGENT ?? null)
          : join(app.getAppPath(), 'tools/fake-agent/main.ts'),
        threadWorkerPath,
        usageWorkerPath,
        settings: deps.settings(),
      }),
      connectMessage: (windowId) => ({ type: 'host:connect', windowId }),
      shutdownMessage: { type: 'host:shutdown' },
      readyType: 'host:ready',
      stoppedType: 'host:stopped',
      onMessage: (message) => this.receive(message),
      onExit: (clean) => this.exited(clean),
    })
  }

  get state(): UtilityHostState {
    return this.host.state
  }

  history(): UtilityHostEvent[] {
    return this.host.history()
  }

  start(): void {
    this.host.start()
  }

  connect(webContents: WebContents): void {
    this.host.connect(webContents)
  }

  revoke(webContents: WebContents): void {
    this.host.revoke(webContents)
  }

  restart(): void {
    this.host.restart()
  }

  pushSettings(settings: HostSettings): void {
    this.host.post({ type: 'host:settings', settings })
  }

  /** The sessions that are working, or none if the host does not answer within `timeoutMs`. */
  busy(timeoutMs: number): Promise<BusySession[]> {
    if (this.host.state !== 'ready') return Promise.resolve([])
    const requestId = this.nextBusyId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.busyRequests.delete(requestId)
        log.warn(`No busy answer within ${timeoutMs} ms`)
        resolve([])
      }, timeoutMs)
      this.busyRequests.set(requestId, (sessions) => {
        clearTimeout(timer)
        resolve(sessions)
      })
      if (!this.host.post({ type: 'host:busy-request', requestId })) {
        this.busyRequests.get(requestId)?.([])
        this.busyRequests.delete(requestId)
      }
    })
  }

  stop(): Promise<void> {
    return this.host.stop()
  }

  private receive(message: HostToMain): void {
    switch (message.type) {
      case 'host:agent-processes':
        if (Array.isArray(message.processes)) {
          this.agentProcesses = message.processes.flatMap((entry) =>
            Number.isSafeInteger(entry?.pid) && entry.pid > 1 && Number.isFinite(entry.startedAt)
              ? [{ pid: entry.pid, startedAt: entry.startedAt }]
              : [],
          )
        }
        break
      case 'host:projects':
        if (isStringList(message.paths)) this.deps.onProjects(message.paths)
        break
      case 'host:auth-commands':
        if (isStringList(message.commands)) this.deps.onAuthCommands(message.commands)
        break
      case 'host:attention':
        this.deps.onAttention(message)
        break
      case 'host:badge':
        if (typeof message.count === 'number') this.deps.onBadge(message.count)
        break
      case 'host:busy': {
        const resolve = this.busyRequests.get(message.requestId)
        if (!resolve) break
        this.busyRequests.delete(message.requestId)
        resolve(Array.isArray(message.sessions) ? message.sessions.filter(isBusySession) : [])
        break
      }
      case 'host:log': {
        const text = typeof message.message === 'string' ? message.message : ''
        if (message.level === 'error') log.error(text)
        else if (message.level === 'warn') log.warn(text)
        else log.info(text)
        break
      }
      default:
        log.warn(`Ignored unknown message "${(message as { type: string }).type}"`)
    }
  }

  private exited(clean: boolean): void {
    for (const resolve of this.busyRequests.values()) resolve([])
    this.busyRequests.clear()
    this.deps.onBadge(0)
    const roots = this.agentProcesses
    this.agentProcesses = []
    // After a clean stop the host has stopped every agent itself, or left it in its own record.
    if (clean || roots.length === 0) return
    log.warn(`Stopping ${roots.length} agent process tree(s) left by the host`)
    // They ran until the host died a moment ago.
    const seenAt = Date.now()
    const trees = roots.map((root) => ({ ...root, seenAt }))
    stopTrees(processControl(process.platform), trees, GRACE_MS).then(
      ({ failures }) => {
        for (const { target, error } of failures) log.warn(`Could not stop ${target}: ${error}`)
      },
      (error: unknown) => log.warn(`Could not stop the agents: ${(error as Error).message}`),
    )
  }
}
