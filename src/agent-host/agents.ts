// Agent supervision: detection, lazy start, one process per agent, idle stop, restarts with
// backoff, sign-in state and the AgentStatus every port sees.

import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentAccount,
  AgentAuthMethod,
  AgentState,
  AgentStatus,
  PlanLimit,
} from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import type { HostSettings } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import {
  AgentConnection,
  AgentRequestError,
  type AcpTransport,
  type AgentInit,
  type ConnectionHooks,
} from './acp/connection'
import { parseUsageReport } from './acp/claude-reports'
import {
  installAdapter,
  removeOtherVersions,
  readInstallFiles,
  removeVersion,
  type InstalledAdapter,
  type InstallOptions,
} from './adapter-install'
import { spawnAgent, type ExitInfo, type StopTimings } from './agent-process'
import {
  detectAgent,
  displayCommand,
  packageSpec,
  type AgentDefinition,
  type CommandWords,
  type DetectContext,
  type Detection,
  type LaunchSpec,
} from './catalog'
import type { Diagnostics } from './diagnostics'
import { HostError, invalidParams } from './errors'
import { isExecutableFile, type Env } from './find-command'
import { t } from './i18n'
import { formatCommand } from './quote'
import { hasReports, runReport } from './reports'
import { TextRing } from './ring'
import type { EnvironmentService } from './shell-env'

export interface LaunchedAgent {
  readonly pid: number | null
  readonly transport: AcpTransport
  readonly exited: Promise<ExitInfo>
  stop(): Promise<ExitInfo>
  reap(): void
}

export interface LaunchOutput {
  stderr(text: string): void
  event(event: string, detail?: string): void
}

export interface AgentLauncher {
  launch(def: AgentDefinition, spec: LaunchSpec, env: Env, output: LaunchOutput): LaunchedAgent
}

/** Spawns real processes, in the home directory; each session's folder travels as `cwd`. */
export function processLauncher(platform: Platform, timings?: StopTimings): AgentLauncher {
  return {
    launch: (_def, spec, env, output) =>
      spawnAgent(spec, {
        platform,
        env,
        cwd: os.homedir(),
        onStderr: output.stderr,
        onEvent: output.event,
        ...(timings ? { timings } : {}),
      }),
  }
}

export interface AgentTimings {
  idleMs: number
  initializeMs: number
  /** How long an adapter install may take, download included. */
  installMs: number
  restartDelaysMs: readonly number[]
  failureWindowMs: number
  maxFailures: number
  progressMs: number
  /** The shortest gap between two `/usage` reports. */
  limitsMs: number
}

export const AGENT_TIMINGS: AgentTimings = {
  idleMs: 30 * 60_000,
  initializeMs: 30_000,
  installMs: 15 * 60_000,
  restartDelaysMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
  failureWindowMs: 5 * 60_000,
  maxFailures: 5,
  progressMs: 250,
  limitsMs: 60_000,
}

export interface AgentRuntime {
  readonly agentId: AgentId
  readonly connection: AgentConnection
  readonly init: AgentInit
}

/** What the session layer tells the agents, and hears back. */
export interface AgentSessionHooks {
  liveSessions(agentId: AgentId): number
  agentReady(agentId: AgentId, runtime: AgentRuntime): void
  agentExited(agentId: AgentId, info: ExitInfo): void
  signedIn(agentId: AgentId): void
}

export interface AgentManagerDeps {
  catalog: readonly AgentDefinition[]
  platform: Platform
  electronPath: string
  appVersion: string
  env: EnvironmentService
  diagnostics: Diagnostics
  launcher: AgentLauncher
  settings(): HostSettings
  /** The folder the `/usage` report's session runs in. */
  reportsDir: string
  /** `<userData>/agents`, where package agents are installed. */
  adaptersDir: string
  detect?(def: AgentDefinition, ctx: DetectContext): Promise<Detection>
  install?(options: InstallOptions): Promise<InstalledAdapter>
  timings?: Partial<AgentTimings>
  status(status: AgentStatus): void
  processes(processes: { agentId: AgentId; pid: number }[]): void
  authCommands(commands: string[]): void
}

class Slot {
  state: AgentState = 'available'
  detection: Detection | null = null
  detail: string | null = null
  init: AgentInit | null = null
  runtime: AgentRuntime | null = null
  launched: LaunchedAgent | null = null
  starting: Promise<AgentRuntime> | null = null
  stopping: Promise<void> | null = null
  /** An install on its own, from a reinstall; installs before a start run inside `starting`. */
  installing: Promise<unknown> | null = null
  installAbort: AbortController | null = null
  /** Says the agent runs an older version because the pinned one could not be installed. */
  adapterNote: string | null = null
  /** What the last launch ran, for restarts while an older version stands in. */
  launchSpec: LaunchSpec | null = null
  /** Older versions are deleted once per host, after the pinned one first initializes. */
  versionsCleaned = false
  intentionalStop = false
  failures: number[] = []
  signIn: AgentStatus['signIn'] = 'unknown'
  account: AgentAccount | null = null
  limits = new Map<string, PlanLimit>()
  limitsRun: Promise<void> | null = null
  limitsReadAt = 0
  progress = new TextRing(8 * 1024)
  restartTimer: ReturnType<typeof setTimeout> | null = null
  idleTimer: ReturnType<typeof setTimeout> | null = null
  progressTimer: ReturnType<typeof setTimeout> | null = null
  lastStatus = ''

  constructor(readonly def: AgentDefinition) {}
}

// For diagnostics, which stay in English.
function describeExit(info: ExitInfo): string {
  if (info.error) return info.error
  if (info.signal) return `was stopped by ${info.signal}`
  return `exited with code ${info.code}`
}

function exitText(agent: string, info: ExitInfo): string {
  if (info.error) return t('agent.exit.error', { agent, error: info.error })
  if (info.signal) return t('agent.exit.signal', { agent, signal: info.signal })
  return t('agent.exit.code', { agent, code: String(info.code) })
}

export class AgentManager {
  private readonly slots = new Map<AgentId, Slot>()
  private readonly timings: AgentTimings
  private detected: Promise<void> | null = null
  private lastAuthCommands = '[]'
  hooks: AgentSessionHooks = {
    liveSessions: () => 0,
    agentReady: () => {},
    agentExited: () => {},
    signedIn: () => {},
  }

  constructor(private readonly deps: AgentManagerDeps) {
    this.timings = { ...AGENT_TIMINGS, ...deps.timings }
    for (const def of deps.catalog) this.slots.set(def.id, new Slot(def))
  }

  has(agentId: AgentId): boolean {
    return this.slots.has(agentId)
  }

  name(agentId: AgentId): string {
    return this.slots.get(agentId)?.def.name ?? agentId
  }

  private slot(agentId: AgentId): Slot {
    const slot = this.slots.get(agentId)
    if (!slot) throw invalidParams(`Unknown agent ${agentId}`)
    return slot
  }

  // Detection.

  /** The first detection pass, after the environment resolves; agents.list waits for it. */
  detectAll(): Promise<void> {
    this.detected ??= (async () => {
      await this.deps.env.ready()
      await Promise.all([...this.slots.values()].map((slot) => this.detect(slot)))
    })()
    return this.detected
  }

  private async detect(slot: Slot): Promise<void> {
    const platform = this.deps.platform
    const override = this.deps.settings().agents[slot.def.id]?.binaryPath ?? null
    const detection = await (this.deps.detect ?? detectAgent)(slot.def, {
      platform,
      env: this.deps.env.agentEnv(),
      electronPath: this.deps.electronPath,
      binaryOverride: override,
      node: this.deps.env.nodeProbe(),
      adaptersDir: this.deps.adaptersDir,
      isExecutable: (file) => isExecutableFile(file, platform),
    })
    slot.detection = detection
    // A running, installing, failed or recovering agent keeps its lifecycle state.
    const idle =
      !slot.launched &&
      !slot.starting &&
      !slot.installing &&
      slot.state !== 'failed' &&
      !slot.restartTimer
    if (idle) {
      slot.state = detection.state
      slot.detail = detection.state === 'available' ? null : detection.detail
    }
    this.emit(slot)
  }

  async list(): Promise<AgentStatus[]> {
    await this.detectAll()
    return this.statuses()
  }

  async check(agentId?: AgentId): Promise<AgentStatus[]> {
    await this.detectAll()
    const slots = agentId ? [this.slot(agentId)] : [...this.slots.values()]
    await Promise.all(slots.map((slot) => this.detect(slot)))
    return this.statuses()
  }

  async reloadEnvironment(): Promise<AgentStatus[]> {
    await this.deps.env.reload()
    await Promise.all([...this.slots.values()].map((slot) => this.detect(slot)))
    return this.statuses()
  }

  /** Binary overrides changed: detect the affected agents again. */
  async settingsChanged(previous: HostSettings, next: HostSettings): Promise<void> {
    // Detecting again rewrites each idle agent's guidance in the new language.
    const changed = [...this.slots.values()].filter(
      (slot) =>
        previous.locale !== next.locale ||
        previous.agents[slot.def.id]?.binaryPath !== next.agents[slot.def.id]?.binaryPath,
    )
    await Promise.all(changed.map((slot) => this.detect(slot)))
  }

  // Lifecycle.

  runtime(agentId: AgentId): AgentRuntime | null {
    const slot = this.slots.get(agentId)
    return slot && !slot.stopping ? slot.runtime : null
  }

  /** Starts the agent if needed; rejects with `agent_unavailable` when it cannot run. */
  async ensureReady(agentId: AgentId): Promise<AgentRuntime> {
    const slot = this.slot(agentId)
    await this.detectAll()
    if (slot.stopping) await slot.stopping
    if (slot.installing) await slot.installing.catch(() => {})
    if (slot.runtime) return slot.runtime
    if (slot.starting) return slot.starting
    if (slot.state === 'failed') {
      throw new HostError(
        'agent_unavailable',
        slot.detail ?? t('agent.failedToStart', { agent: slot.def.name }),
        { agentId, state: 'failed' },
      )
    }
    if (slot.detection?.state !== 'available') await this.detect(slot)
    const detection = slot.detection
    if (detection?.state !== 'available') {
      throw new HostError(
        'agent_unavailable',
        detection?.detail ?? t('agent.notAvailable', { agent: slot.def.name }),
        {
          agentId,
          state: detection?.state ?? 'not-installed',
        },
      )
    }
    return this.start(slot, detection.spec, 'demand')
  }

  /** Launches `spec`, or installs the pinned adapter first when it is null. */
  private async start(
    slot: Slot,
    spec: LaunchSpec | null,
    reason: 'demand' | 'restart',
  ): Promise<AgentRuntime> {
    if (slot.restartTimer) {
      clearTimeout(slot.restartTimer)
      slot.restartTimer = null
    }
    const run = (async () => this.launch(slot, spec ?? (await this.install(slot))))()
    slot.starting = run
    try {
      const runtime = await run
      this.cleanUpVersions(slot)
      this.hooks.agentReady(slot.def.id, runtime)
      this.sessionsChanged(slot.def.id)
      return runtime
    } catch (error) {
      const message = (error as Error).message
      const tooMany = this.recordFailure(slot)
      if (reason === 'demand' || tooMany) {
        slot.state = 'failed'
        slot.detail =
          tooMany && reason === 'restart'
            ? t('agent.failedTooOften', { detail: message, count: this.timings.maxFailures })
            : message
      } else {
        slot.state = 'crashed'
        slot.detail = message
        this.scheduleRestart(slot)
      }
      this.emit(slot)
      throw new HostError('agent_unavailable', slot.detail ?? message, {
        agentId: slot.def.id,
        state: slot.state,
      })
    } finally {
      slot.starting = null
    }
  }

  private async launch(slot: Slot, spec: LaunchSpec): Promise<AgentRuntime> {
    const { diagnostics } = this.deps
    const agentId = slot.def.id
    slot.state = 'starting'
    slot.detail = null
    slot.progress.clear()
    slot.intentionalStop = false
    slot.launchSpec = spec
    this.emit(slot)
    diagnostics.event(agentId, 'start', formatCommand(spec.display, this.deps.platform))
    const launched = this.deps.launcher.launch(slot.def, spec, this.deps.env.agentEnv(), {
      stderr: (text) => this.onStderr(slot, text),
      event: (event, detail) => diagnostics.event(agentId, event, detail),
    })
    slot.launched = launched
    this.emitProcesses()
    const connection = AgentConnection.connect(launched.transport, this.connectionHooks(slot))
    void launched.exited.then((info) => this.onExit(slot, launched, connection, info))

    const abort = new AbortController()
    const timeoutMs = this.timings.initializeMs
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const init = await Promise.race([
        connection.initialize(this.deps.appVersion, abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort()
            reject(
              new Error(
                t('agent.initializeTimeout', {
                  agent: slot.def.name,
                  seconds: String(timeoutMs / 1000),
                }),
              ),
            )
          }, timeoutMs)
        }),
        launched.exited.then((info): never => {
          const tail = slot.progress.lastLines(3).join(' ')
          const exit = exitText(slot.def.name, info)
          throw new Error(`${t('agent.exitedBeforeReady', { exit })}${tail ? ` ${tail}` : ''}`)
        }),
      ])
      if (init.protocolVersion !== 1) {
        throw new Error(
          `${slot.def.name} speaks an unsupported protocol version (${init.protocolVersion}).`,
        )
      }
      const runtime: AgentRuntime = { agentId, connection, init }
      slot.init = init
      slot.runtime = runtime
      slot.state = 'ready'
      slot.detail = null
      diagnostics.event(agentId, 'ready', init.version ?? undefined)
      this.emit(slot)
      return runtime
    } catch (error) {
      slot.intentionalStop = true
      connection.close()
      await launched.stop()
      throw error instanceof AgentRequestError
        ? new Error(`${slot.def.name} failed to initialize: ${error.message}`)
        : error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private onExit(
    slot: Slot,
    launched: LaunchedAgent,
    connection: AgentConnection,
    info: ExitInfo,
  ): void {
    const agentId = slot.def.id
    this.deps.diagnostics.event(agentId, 'exit', describeExit(info))
    connection.close()
    if (slot.launched !== launched) return
    slot.launched = null
    slot.runtime = null
    this.emitProcesses()
    if (slot.intentionalStop || slot.starting) {
      // A stop we asked for, or a start that failed and reports itself.
      if (!slot.starting) {
        slot.state = slot.detection?.state ?? 'available'
        slot.detail = null
        this.emit(slot)
      }
      return
    }
    launched.reap()
    slot.state = 'crashed'
    slot.detail = t('agent.exited', { exit: exitText(slot.def.name, info) })
    this.hooks.agentExited(agentId, info)
    if (this.recordFailure(slot)) {
      slot.state = 'failed'
      slot.detail = t('agent.stoppedTooOften', {
        detail: slot.detail,
        count: this.timings.maxFailures,
      })
    } else if (this.hooks.liveSessions(agentId) > 0) {
      this.scheduleRestart(slot)
    }
    this.emit(slot)
  }

  private recordFailure(slot: Slot): boolean {
    const now = Date.now()
    slot.failures = slot.failures.filter((at) => now - at < this.timings.failureWindowMs)
    slot.failures.push(now)
    return slot.failures.length >= this.timings.maxFailures
  }

  private scheduleRestart(slot: Slot): void {
    if (slot.restartTimer) return
    const delays = this.timings.restartDelaysMs
    const delay = delays[Math.min(slot.failures.length - 1, delays.length - 1)] ?? 0
    this.deps.diagnostics.event(slot.def.id, 'restart scheduled', `${delay} ms`)
    slot.restartTimer = setTimeout(() => {
      slot.restartTimer = null
      if (slot.state === 'failed' || slot.launched || slot.starting) return
      if (this.hooks.liveSessions(slot.def.id) === 0) {
        slot.state = slot.detection?.state ?? 'available'
        this.emit(slot)
        return
      }
      const detection = slot.detection
      if (detection?.state !== 'available') return
      this.start(slot, detection.spec ?? slot.launchSpec, 'restart').catch(() => {
        // start() records the failure and schedules the next attempt.
      })
    }, delay)
  }

  // Adapter installs.

  /**
   * Installs the pinned adapter and returns how to run it. When that fails and another version is
   * installed, returns that one instead and says so in the status.
   */
  private async install(slot: Slot): Promise<LaunchSpec> {
    const detection = slot.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    if (!detection || detection.state !== 'available' || !adapter) {
      throw new Error(`${slot.def.name} has no adapter to install.`)
    }
    const { diagnostics, platform } = this.deps
    const agentId = slot.def.id
    slot.state = 'installing'
    slot.detail = null
    slot.progress.clear()
    this.emit(slot)
    const abort = new AbortController()
    slot.installAbort = abort
    const started = Date.now()
    diagnostics.event(agentId, 'install', `${adapter.package}@${adapter.version}`)
    try {
      if (!adapter.npm) throw new Error('npm was not found on PATH.')
      const installed = await (this.deps.install ?? installAdapter)({
        root: this.deps.adaptersDir,
        agentId,
        package: adapter.package,
        version: adapter.version,
        npm: adapter.npm,
        nodeVersion: adapter.nodeVersion,
        platform,
        env: this.deps.env.agentEnv(),
        timeoutMs: this.timings.installMs,
        signal: abort.signal,
        onOutput: (text) => this.onProgress(slot, text),
      })
      diagnostics.event(agentId, 'installed', `${adapter.version} in ${Date.now() - started} ms`)
      const spec = packageSpec(adapter.node, installed.entry, platform)
      slot.detection = { ...detection, spec, adapter: { ...adapter, installed: true } }
      slot.adapterNote = null
      return spec
    } catch (error) {
      const message = (error as Error).message
      diagnostics.event(agentId, 'install failed', message)
      if (adapter.fallback && !abort.signal.aborted) {
        slot.adapterNote = t('agent.runningFallback', {
          fallback: adapter.fallback.version,
          version: adapter.version,
          message,
        })
        return adapter.fallback.spec
      }
      throw new Error(t('agent.installFailed', { agent: slot.def.name, message }), {
        cause: error,
      })
    } finally {
      slot.installAbort = null
    }
  }

  /** Once the pinned version runs, the versions it replaced go. */
  private cleanUpVersions(slot: Slot): void {
    const detection = slot.detection
    if (slot.versionsCleaned || detection?.state !== 'available' || !detection.adapter?.installed) {
      return
    }
    if (!detection.spec || slot.launchSpec !== detection.spec) return
    slot.versionsCleaned = true
    const agentId = slot.def.id
    removeOtherVersions(this.deps.adaptersDir, agentId, detection.adapter.version).then(
      (removed) => {
        if (removed.length > 0) this.deps.diagnostics.event(agentId, 'removed', removed.join(', '))
      },
      (error: unknown) =>
        this.deps.diagnostics.log(
          'warn',
          `${slot.def.name}: could not remove older versions: ${(error as Error).message}`,
        ),
    )
  }

  /**
   * Deletes the installed adapter and installs it again, while no session uses the agent. The
   * slot is claimed before the first await, so a start that comes meanwhile waits for the result.
   */
  async reinstall(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    const { launch } = slot.def
    if (launch.kind !== 'package') {
      throw invalidParams(`${slot.def.name} is not installed by OverBench`)
    }
    if (slot.installing || slot.starting) {
      throw new HostError('busy', t('agent.busyInstalling', { agent: slot.def.name }))
    }
    if (this.hooks.liveSessions(agentId) > 0) {
      throw new HostError('busy', t('agent.closeSessionsFirst', { agent: slot.def.name }))
    }
    const run = (async () => {
      await this.detectAll()
      await this.stopProcess(slot)
      await removeVersion(this.deps.adaptersDir, agentId, launch.version)
      slot.failures = []
      slot.versionsCleaned = false
      slot.state = 'available'
      slot.detail = null
      await this.detect(slot)
      if (slot.detection?.state !== 'available') {
        throw new HostError(
          'agent_unavailable',
          slot.detection?.detail ?? t('agent.cannotInstall', { agent: slot.def.name }),
        )
      }
      try {
        await this.install(slot)
        slot.state = 'available'
      } catch (error) {
        slot.state = 'failed'
        slot.detail = (error as Error).message
        throw new HostError('agent_unavailable', slot.detail, { agentId, state: 'failed' })
      } finally {
        this.emit(slot)
      }
    })()
    slot.installing = run
    try {
      await run
    } finally {
      slot.installing = null
    }
  }

  /** Clears `failed` and starts the agent again when live sessions need it. */
  async retry(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    if (slot.state === 'failed' || slot.state === 'crashed') {
      slot.failures = []
      if (slot.restartTimer) {
        clearTimeout(slot.restartTimer)
        slot.restartTimer = null
      }
      slot.state = 'available'
      slot.detail = null
      await this.detect(slot)
    }
    if (this.hooks.liveSessions(agentId) > 0 && !slot.runtime) await this.ensureReady(agentId)
  }

  /** Arms or clears the idle stop after the agent's live session count changed. */
  sessionsChanged(agentId: AgentId): void {
    const slot = this.slots.get(agentId)
    if (!slot) return
    const live = this.hooks.liveSessions(agentId)
    if (live > 0 || !slot.runtime) {
      if (slot.idleTimer) {
        clearTimeout(slot.idleTimer)
        slot.idleTimer = null
      }
      return
    }
    slot.idleTimer ??= setTimeout(() => {
      slot.idleTimer = null
      if (this.hooks.liveSessions(agentId) === 0) {
        this.deps.diagnostics.event(agentId, 'idle stop')
        void this.stop(agentId)
      }
    }, this.timings.idleMs)
  }

  async stop(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    slot.installAbort?.abort()
    if (slot.installing) await slot.installing.catch(() => {})
    await this.stopProcess(slot)
  }

  /** Stops the agent's process, after a start in progress settles. */
  private async stopProcess(slot: Slot): Promise<void> {
    for (const timer of [slot.idleTimer, slot.restartTimer, slot.progressTimer]) {
      if (timer) clearTimeout(timer)
    }
    slot.idleTimer = slot.restartTimer = slot.progressTimer = null
    if (slot.starting) await slot.starting.catch(() => {})
    const launched = slot.launched
    if (!launched) return
    slot.intentionalStop = true
    slot.state = 'stopping'
    this.emit(slot)
    slot.stopping = launched.stop().then(() => {})
    try {
      await slot.stopping
    } finally {
      slot.stopping = null
    }
  }

  /** Stops every agent in parallel, with the documented sequence. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((agentId) => this.stop(agentId)))
  }

  // Sign-in, account and limits.

  private connectionHooks(slot: Slot): ConnectionHooks {
    const { diagnostics } = this.deps
    const agentId = slot.def.id
    return {
      traffic: (direction, message) => diagnostics.traffic(agentId, direction, message),
      account: (account) => this.setAccount(slot, account),
      ignored: (sessionId, what) =>
        diagnostics.event(agentId, 'ignored', sessionId ? `${what} (session ${sessionId})` : what),
      log: (level, message) => diagnostics.log(level, `${slot.def.name}: ${message}`),
    }
  }

  private setAccount(slot: Slot, account: AgentAccount): void {
    const wasRequired = slot.signIn === 'required'
    slot.account = account
    slot.signIn = account.kind === 'none' ? 'required' : 'signed-in'
    this.emit(slot)
    if (wasRequired && slot.signIn === 'signed-in') this.hooks.signedIn(slot.def.id)
  }

  setLimit(agentId: AgentId, limit: PlanLimit): void {
    const slot = this.slots.get(agentId)
    if (!slot) return
    const before = slot.limits.get(limit.window)
    // Claude Code often reports a window without its utilization; the use `/usage` read for the
    // same period still holds. `/usage` gives the reset to the minute, the events to the second.
    const samePeriod =
      before?.resetsAt != null &&
      limit.resetsAt !== null &&
      Math.abs(before.resetsAt - limit.resetsAt) < 60_000
    const keep = limit.usedPercent === null && before?.usedPercent != null && samePeriod
    slot.limits.set(limit.window, keep ? { ...limit, usedPercent: before.usedPercent } : limit)
    this.emit(slot)
  }

  /**
   * Reads the current use of every plan limit from the agent's `/usage` report, at most once a
   * minute, starting the agent if needed; the windows arrive in its status. Rate-limit events
   * report a window only when it changes, so without this most windows would stay unknown.
   */
  async refreshLimits(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    if (!hasReports(agentId)) return
    await this.detectAll()
    if (slot.signIn === 'required' || (!slot.runtime && slot.detection?.state !== 'available')) {
      return
    }
    if (slot.limitsRun) return slot.limitsRun
    if (Date.now() - slot.limitsReadAt < this.timings.limitsMs) return
    slot.limitsRun = this.readLimits(slot).finally(() => {
      slot.limitsRun = null
    })
    return slot.limitsRun
  }

  private async readLimits(slot: Slot): Promise<void> {
    const runtime = await this.ensureReady(slot.def.id)
    const dir = this.deps.reportsDir
    await mkdir(dir, { recursive: true })
    const log = (message: string): void => this.deps.diagnostics.log('warn', message)
    let messages: string[]
    try {
      messages = await runReport(
        runtime,
        async () => (await runtime.connection.newSession(dir)).acpSessionId,
        '/usage',
        log,
      )
    } catch (error) {
      if (error instanceof AgentRequestError && error.kind === 'auth_required') {
        this.authRequired(slot.def.id)
      }
      throw agentError(error)
    }
    const now = Date.now()
    slot.limitsReadAt = now
    const limits = messages
      .map((text) => parseUsageReport(text, now))
      .findLast((report) => report !== null)
    if (!limits) {
      log(`${slot.def.name}: /usage gave no report OverBench can read`)
      return
    }
    for (const limit of limits) {
      const before = slot.limits.get(limit.window)
      // A warning or a block the agent pushed holds until its window resets.
      const held =
        limit.state === 'ok' && before && before.state !== 'ok' && (before.resetsAt ?? 0) > now
      slot.limits.set(limit.window, held ? { ...limit, state: before.state } : limit)
    }
    this.emit(slot)
  }

  authRequired(agentId: AgentId): void {
    const slot = this.slots.get(agentId)
    if (!slot || slot.signIn === 'required') return
    slot.signIn = 'required'
    this.emit(slot)
  }

  /** A session request succeeded, so the agent is signed in. */
  signedIn(agentId: AgentId): void {
    const slot = this.slots.get(agentId)
    if (!slot || slot.signIn === 'signed-in') return
    slot.signIn = 'signed-in'
    this.emit(slot)
  }

  async authenticate(agentId: AgentId, methodId: string): Promise<void> {
    const runtime = await this.ensureReady(agentId)
    const method = runtime.init.authMethods.find((m) => m.id === methodId)
    if (!method) throw invalidParams(`${this.name(agentId)} has no sign-in method ${methodId}`)
    if (method.type !== 'agent') {
      throw invalidParams(`${method.name} runs in a terminal; use its command instead`)
    }
    try {
      await runtime.connection.authenticate(methodId)
    } catch (error) {
      throw agentError(error)
    }
    const slot = this.slot(agentId)
    slot.signIn = 'signed-in'
    this.emit(slot)
    this.hooks.signedIn(agentId)
  }

  async logout(agentId: AgentId): Promise<void> {
    const runtime = await this.ensureReady(agentId)
    if (!runtime.init.capabilities.logout) {
      throw new HostError('agent_unavailable', t('agent.noLogout', { agent: this.name(agentId) }))
    }
    try {
      await runtime.connection.logout()
    } catch (error) {
      throw agentError(error)
    }
    const slot = this.slot(agentId)
    slot.signIn = 'required'
    this.emit(slot)
  }

  // Status.

  private display(slot: Slot): CommandWords {
    const detection = slot.detection
    if (detection?.state === 'available') {
      const spec = slot.state === 'ready' || slot.state === 'starting' ? slot.launchSpec : null
      const shown = spec ?? detection.spec
      if (shown) return shown.display
    }
    const override = this.deps.settings().agents[slot.def.id]?.binaryPath ?? null
    return displayCommand(slot.def, this.deps.electronPath, override, this.deps.adaptersDir)
  }

  status(agentId: AgentId): AgentStatus {
    const slot = this.slot(agentId)
    const platform = this.deps.platform
    const display = this.display(slot)
    const init = slot.init
    const authMethods: AgentAuthMethod[] = (init?.authMethods ?? []).map((method) => ({
      id: method.id,
      name: method.name,
      ...(method.description ? { description: method.description } : {}),
      type: method.type,
      ...(method.type === 'terminal'
        ? {
            command: formatCommand(
              {
                command: display.command,
                args: [...display.args, ...method.args],
                env: { ...display.env, ...method.env },
              },
              platform,
            ),
          }
        : {}),
    }))
    const capabilities = init?.capabilities
    const { launch } = slot.def
    const adapter = slot.detection?.state === 'available' ? slot.detection.adapter : null
    return {
      id: slot.def.id,
      name: slot.def.name,
      state: slot.state,
      version: init?.version ?? null,
      package:
        launch.kind === 'package'
          ? {
              name: launch.package,
              version: launch.version,
              installed: adapter?.installed ?? false,
            }
          : null,
      signIn: slot.signIn,
      authMethods,
      canLogout: capabilities?.logout ?? false,
      account: slot.account,
      limits: [...slot.limits.values()],
      detail: slot.detail ?? slot.adapterNote,
      installUrl:
        slot.state === 'not-installed' ||
        slot.state === 'node-missing' ||
        slot.state === 'node-outdated'
          ? slot.def.install.url
          : null,
      progress:
        slot.state === 'starting' || slot.state === 'installing' ? slot.progress.lastLines(5) : [],
      launchCommand: formatCommand(display, platform),
      binaryOverride: this.deps.settings().agents[slot.def.id]?.binaryPath ?? null,
      capabilities: {
        loadSession: capabilities?.loadSession ?? false,
        listSessions: capabilities?.listSessions ?? false,
        resumeSession: capabilities?.resumeSession ?? false,
        closeSession: capabilities?.closeSession ?? false,
        deleteSession: capabilities?.deleteSession ?? false,
        forkSession: capabilities?.forkSession ?? false,
        // codex-acp 2.2.2 ignores `idleBehavior` and starts a turn of its own when none is
        // running (its PR #593 would fix it), which OverBench would not know about.
        steering: (capabilities?.steering ?? false) && slot.def.id !== 'codex',
        reports: hasReports(slot.def.id),
      },
    }
  }

  statuses(): AgentStatus[] {
    return [...this.slots.keys()].map((agentId) => this.status(agentId))
  }

  /** The files of the adapter version in use, for diagnostics. */
  async adapterFiles(agentId: AgentId): Promise<{ installed: unknown; lock: unknown } | null> {
    const slot = this.slots.get(agentId)
    const detection = slot?.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    if (!slot || !adapter) return null
    const version = adapter.installed ? adapter.version : adapter.fallback?.version
    if (!version) return null
    return readInstallFiles(path.join(this.deps.adaptersDir, agentId, version))
  }

  /** The raw capabilities of each agent's last `initialize`, for diagnostics. */
  rawCapabilities(agentId: AgentId): unknown {
    return this.slots.get(agentId)?.init?.raw ?? null
  }

  ids(): AgentId[] {
    return [...this.slots.keys()]
  }

  private onStderr(slot: Slot, text: string): void {
    this.deps.diagnostics.stderr(slot.def.id, text)
    if (slot.state === 'starting') this.onProgress(slot, text)
  }

  /** npm's output while installing, or the agent's stderr while starting. */
  private onProgress(slot: Slot, text: string): void {
    if (slot.state === 'installing') this.deps.diagnostics.stderr(slot.def.id, text)
    slot.progress.push(text)
    // Progress lines arrive fast while npm downloads; a few status events a second is enough.
    slot.progressTimer ??= setTimeout(() => {
      slot.progressTimer = null
      this.emit(slot)
    }, this.timings.progressMs)
  }

  private emit(slot: Slot): void {
    const status = this.status(slot.def.id)
    const json = JSON.stringify(status)
    if (json !== slot.lastStatus) {
      slot.lastStatus = json
      this.deps.status(status)
    }
    const commands = this.statuses().flatMap((s) =>
      s.authMethods.flatMap((method) => (method.command ? [method.command] : [])),
    )
    const commandsJson = JSON.stringify(commands)
    if (commandsJson !== this.lastAuthCommands) {
      this.lastAuthCommands = commandsJson
      this.deps.authCommands(commands)
    }
  }

  private emitProcesses(): void {
    this.deps.processes(this.processes())
  }

  processes(): { agentId: AgentId; pid: number }[] {
    return [...this.slots.values()].flatMap((slot) =>
      slot.launched?.pid != null ? [{ agentId: slot.def.id, pid: slot.launched.pid }] : [],
    )
  }
}

/** Maps a failed ACP request to the port error the renderer acts on. */
export function agentError(error: unknown): HostError {
  if (error instanceof HostError) return error
  if (error instanceof AgentRequestError) {
    switch (error.kind) {
      case 'auth_required':
        return new HostError('auth_required', error.message, { code: error.code })
      case 'closed':
        return new HostError('agent_unavailable', t('agent.stoppedBeforeAnswer'))
      default:
        return new HostError('agent_error', error.message, {
          code: error.code,
          ...(error.data !== undefined ? { data: error.data } : {}),
        })
    }
  }
  return new HostError('internal', (error as Error)?.message ?? String(error))
}
