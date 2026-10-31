// The daemon's side of the agent host and the terminal host, as main's AgentHost and TerminalHost
// are the app's: their init, what they ask of main, and what is left after a crash. The daemon has
// no windows, notifications, tray or browser, so what serves those is not answered.

import path from 'node:path'
import type {
  HostToMain,
  MainToHost,
  MainToTerminalHost,
  TerminalHostToMain,
} from '@shared/host-control'
import type { Locale } from '@shared/locale'
import type { SettingsFile } from '@shared/settings'
import { processControl, stopTrees, type ProcessId } from '../agent-host/process-tree'
import { createLogger } from '../main/log'
import { hostSettings, terminalSettings } from '../main/settings-schema'
import type { HostName, HostStatus } from './control'
import { ForkedHost, type HostTimings } from './forked-host'

const log = createLogger('daemon')

const MAX_LIST = 10_000
const MAX_STRING = 8192
/** How long an agent's tree gets between SIGTERM and SIGKILL after its host died, as in main. */
const GRACE_MS = 2_000

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_STRING)
  )
}

export interface HostsOptions {
  /** The folder of the daemon's build, which holds each host's bundle. */
  bundleDir: string
  dataPath: string
  version: string
  systemLocale: Locale
  settings(): SettingsFile
  env: NodeJS.ProcessEnv
  timings?: HostTimings
}

export class Hosts {
  private readonly agent: ForkedHost<MainToHost, HostToMain>
  private readonly terminal: ForkedHost<MainToTerminalHost, TerminalHostToMain>
  private projects: string[] = []
  private authCommands: string[] = []
  private agentProcesses: ProcessId[] = []

  constructor(options: HostsOptions) {
    const bundle = (name: string): string => path.join(options.bundleDir, name)
    this.agent = new ForkedHost<MainToHost, HostToMain>({
      log: createLogger('agent-host'),
      modulePath: bundle('agent-host.cjs'),
      socketName: 'agent-host',
      env: options.env,
      timings: options.timings,
      initMessage: (socketPath) => ({
        type: 'host:init',
        userDataPath: options.dataPath,
        appVersion: options.version,
        platform: process.platform,
        isPackaged: true,
        nodeRuntime: { command: process.execPath, env: {} },
        fakeAgentPath: options.env.KETTU_FAKE_AGENT || null,
        threadWorkerPath: bundle('thread-worker.cjs'),
        usageWorkerPath: bundle('usage-worker.cjs'),
        sessionRouterPath: bundle('session-router.cjs'),
        settings: hostSettings(options.settings(), options.systemLocale),
        socketPath,
      }),
      shutdownMessage: { type: 'host:shutdown' },
      readyType: 'host:ready',
      stoppedType: 'host:stopped',
      onMessage: (message) => this.receive(message),
      onExit: (clean) => this.agentExited(clean),
    })
    this.terminal = new ForkedHost<MainToTerminalHost, TerminalHostToMain>({
      log: createLogger('terminal-host'),
      modulePath: bundle('terminal-host.cjs'),
      socketName: 'terminal-host',
      env: options.env,
      timings: options.timings,
      initMessage: (socketPath) => ({
        type: 'terminal-host:init',
        platform: process.platform,
        appVersion: options.version,
        settings: terminalSettings(options.settings()),
        projects: this.projects,
        authCommands: this.authCommands,
        socketPath,
      }),
      shutdownMessage: { type: 'terminal-host:shutdown' },
      readyType: 'terminal-host:ready',
      stoppedType: 'terminal-host:stopped',
      onMessage: (message) => log.warn(`Ignored terminal host message "${message.type}"`),
    })
  }

  /** Starts the agent host; the terminal host waits for its first use. */
  start(): void {
    this.agent.start()
  }

  /** A host's socket once it is ready; rejects with `isUnavailable` when it cannot run. */
  socket(host: HostName): Promise<string> {
    return (host === 'agent' ? this.agent : this.terminal).ready()
  }

  status(): Record<HostName, HostStatus> {
    const of = (host: ForkedHost<unknown, { type: string }>): HostStatus => ({
      state: host.state,
      pid: host.pid,
      restarts: host.restarts,
    })
    return { agent: of(this.agent), terminal: of(this.terminal) }
  }

  /** Stops both hosts, as main does when the app quits. */
  async stop(): Promise<void> {
    await Promise.all([this.agent.stop(), this.terminal.stop()])
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
        if (isStringList(message.paths)) {
          this.projects = message.paths
          this.terminal.post({ type: 'terminal-host:projects', paths: message.paths })
        }
        break
      case 'host:auth-commands':
        if (isStringList(message.commands)) {
          this.authCommands = message.commands
          this.terminal.post({ type: 'terminal-host:auth-commands', commands: message.commands })
        }
        break
      case 'host:browser-call':
        if (Number.isSafeInteger(message.callId)) {
          this.agent.post({
            type: 'browser-result',
            callId: message.callId,
            error: { code: 'no_page', message: 'This host drives no browser.' },
          })
        }
        break
      case 'host:log': {
        const text = typeof message.message === 'string' ? message.message : ''
        if (message.level === 'error') log.error(text)
        else if (message.level === 'warn') log.warn(text)
        else log.info(text)
        break
      }
      // The app's notifications, badge, tray, power saving, media and artifacts; the answers to
      // requests only main sends.
      case 'host:attention':
      case 'host:badge':
      case 'host:busy-changed':
      case 'host:routines-working':
      case 'host:media-grant':
      case 'host:media-revoke':
      case 'host:service-port':
      case 'host:busy':
      case 'host:granted':
      case 'host:artifact-content':
      case 'host:artifact-list':
      case 'host:artifact-import':
        break
      default:
        log.warn(`Ignored unknown message "${(message as { type: string }).type}"`)
    }
  }

  private agentExited(clean: boolean): void {
    const roots = this.agentProcesses
    this.agentProcesses = []
    // After a clean stop the host has stopped every agent itself.
    if (clean || roots.length === 0) return
    log.warn(`Stopping ${roots.length} agent process tree(s) left by the agent host`)
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
