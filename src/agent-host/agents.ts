// Agent supervision: detection, lazy start, one process per agent, idle stop, crash counting,
// sign-in state and the AgentStatus every port sees.

import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentAccount,
  AgentAuthMethod,
  AgentCliSource,
  AgentDetails,
  AgentInstallMethod,
  AgentState,
  AgentStatus,
  AgentTask,
  AgentUpdate,
  InstalledCli,
  PlanLimit,
} from '@shared/agent-host'
import type { AgentProcess } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { HostSettings } from '@shared/settings'
import type { AgentId, ConfigOption } from '@shared/thread'
import {
  AgentConnection,
  AgentRequestError,
  type AcpTransport,
  type AgentInit,
  type ConnectionHooks,
} from './acp/connection'
import {
  installAdapter,
  NPM_INSTALL_ARGS,
  OMIT_CLI_ARG,
  programFailure,
  readInstallFiles,
  removeInstall,
  removeOlderInstalls,
  runProgram,
  type InstalledAdapter,
  type InstallOptions,
  type ProgramOptions,
  type ProgramRun,
} from './adapter-install'
import {
  CLI_VERSION_SOURCES,
  configLocations,
  readAgentDetails,
  readCliVersion,
} from './agent-details'
import { spawnAgent, type ExitInfo, type StopTimings } from './agent-process'
import type { AgentTrees } from './agent-trees'
import { decideUpdate, fetchLatest, type LatestOptions } from './agent-updates'
import { installedFolder, installPlans, type InstallPlan } from './binary-install'
import {
  detectAgent,
  displayCommand,
  type AgentDefinition,
  type CommandWords,
  type DetectContext,
  type Detection,
  type LaunchSpec,
} from './catalog'
import { removeReportThreads } from './codex-report-threads'
import type { Diagnostics } from './diagnostics'
import { HostError, invalidParams } from './errors'
import { getEnv, isExecutableFile, type Env } from './find-command'
import { t } from './i18n'
import { CliVersions, type CliProbe, type CliVersion } from './installed-cli'
import { claudeJsonPath, readPlanTier } from './plan-tier'
import { QUIT_REASON, type ToolOptions } from './process-tree'
import { formatCommand } from './quote'
import {
  hiddenRemoval,
  hiddenSessionMeta,
  limitsReport,
  removeHiddenSession,
  runReport,
  type LimitsReport,
  type Removal,
} from './reports'
import { TextRing } from './ring'
import type { EnvironmentService } from './shell-env'
import type { AgentsFile, AgentUpdatesFile, RememberedInit } from './storage'
import { compareVersions } from './versions'

export interface LaunchedAgent {
  readonly pid: number | null
  readonly startedAt: number
  readonly transport: AcpTransport
  readonly exited: Promise<ExitInfo>
  readonly hasExited: boolean
  stop(tools?: ToolOptions): Promise<ExitInfo>
  /** Ends it now, for a quit that cannot wait for `stop` any longer. */
  kill(): Promise<void>
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
  failureWindowMs: number
  maxFailures: number
  progressMs: number
  /** The shortest gap between two `/usage` reports. */
  limitsMs: number
  /** How long the hidden `session/new` that reads an agent's options may take. */
  optionsMs: number
  /** How long one `npm view` of the update check may take. */
  updateViewMs: number
  /** How long after the host starts a due update check waits, so it stays out of startup. */
  updateDelayMs: number
  /** How often updates are checked while the host runs. */
  updateIntervalMs: number
  /**
   * How long a quit waits for the agents to stop before it kills what still runs and writes its
   * state: main kills the host 6 s after `host:shutdown`, and the longest quit adds up to 5.25 s.
   */
  quitStopMs: number
}

export const AGENT_TIMINGS: AgentTimings = {
  idleMs: 5 * 60_000,
  initializeMs: 30_000,
  installMs: 15 * 60_000,
  failureWindowMs: 5 * 60_000,
  maxFailures: 5,
  progressMs: 250,
  limitsMs: 60_000,
  optionsMs: 30_000,
  updateViewMs: 20_000,
  updateDelayMs: 60_000,
  updateIntervalMs: 24 * 60 * 60_000,
  quitStopMs: 3_500,
}

export interface AgentRuntime {
  readonly agentId: AgentId
  readonly connection: AgentConnection
  readonly init: AgentInit
}

/** What the session layer tells the agents, and hears back. */
export interface AgentSessionHooks {
  liveSessions(agentId: AgentId): number
  agentExited(agentId: AgentId, info: ExitInfo): void
  signedIn(agentId: AgentId): void
  /** Whether New session knows the agent's config options already. */
  optionsKnown(agentId: AgentId): boolean
  /** The config options of a hidden session in `folder`, at the agent's own values. */
  optionsSeen(agentId: AgentId, config: ConfigOption[], folder: string): void
  /** The agent's configuration folder was changed in Settings; it applies from its next start. */
  configChanged(agentId: AgentId): void
}

/** The configuration folder an agent runs with, and the one picked in Settings, if any. */
export interface RunningConfig {
  folder: string
  chosen: string | null
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
  /** The folder hidden sessions run in: the reports' and the one that reads the options. */
  reportsDir: string
  /** `<userData>/agents`, where package agents are installed. */
  adaptersDir: string
  detect?(def: AgentDefinition, ctx: DetectContext): Promise<Detection>
  install?(options: InstallOptions): Promise<InstalledAdapter>
  /** Asks npm for an adapter's newest version and the CLI it carries. */
  fetchLatest?(options: LatestOptions): Promise<AgentUpdate>
  /** Runs a binary agent's install route, and `npm prefix -g` after one. */
  runProgram?(options: ProgramOptions): Promise<ProgramRun>
  /** Asks the user's own Claude Code or Codex its version, in place of `cliVersions`. */
  probeCli?: CliProbe
  /** Where the versions of the user's CLIs are asked and kept; one of its own by default. */
  cliVersions?: CliVersions
  timings?: Partial<AgentTimings>
  status(status: AgentStatus): void
  processes(processes: AgentProcess[]): void
  /** Notes each launch, and stops what an agent's process leaves behind once it exits. */
  trees?: AgentTrees
  authCommands(commands: string[]): void
  /** Keeps what the agents last reported about their accounts and plans, for the next run. */
  remember?(file: AgentsFile): void
  /** Keeps what the last update check found, for the next run. */
  rememberUpdates?(file: AgentUpdatesFile): void
}

/** An install that was stopped on purpose, which leaves the agent as it was rather than failed. */
class InstallCancelled extends Error {}

interface UpdateCheck {
  checked: number
  /** Why each agent's check failed, in the user's terms. */
  failures: string[]
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
  /** What the running launch ran, which is the command shown while it runs. */
  launchSpec: LaunchSpec | null = null
  /** The configuration folder the running launch got, for an agent whose folder can be chosen. */
  launchConfig: RunningConfig | null = null
  /** The install whose older siblings were last deleted, once it first initialized. */
  cleanedDir: string | null = null
  /** What the last update check found, and when it finished. */
  latest: AgentUpdate | null = null
  checkedAt: number | null = null
  /** The update whose notice the user dismissed in the sidebar, until a newer one is found. */
  skipped: AgentUpdate | null = null
  /** When a check last ran for this agent, found or failed; the daily check waits from it. */
  attemptedAt: number | null = null
  rememberedUpdate = 'null'
  /** The CLI version of the install a start runs, read at detection. */
  installedCli: string | null = null
  /** A binary agent's version, from its own `--version`, until it starts and reports its own. */
  binaryVersion: string | null = null
  /** The program `binaryVersion` was read from, so an answer for another one is dropped. */
  binaryProgram: string | null = null
  /** The `--version` failure already logged, so a repeated detection logs it once. */
  binaryVersionFailure: string | null = null
  /** A binary agent's install routes, found at detection. */
  installPlans: InstallPlan[] = []
  /** The user's CLI a start failed with; the copy runs until the setting or environment changes. */
  cliFailure: { path: string; reason: string } | null = null
  /** An install or update the user asked for, which runs beside the agent's own lifecycle. */
  task: Omit<AgentTask, 'progress'> | null = null
  taskRun: Promise<void> | null = null
  taskAbort: AbortController | null = null
  taskOutput = new TextRing(8 * 1024)
  intentionalStop = false
  failures: number[] = []
  signIn: AgentStatus['signIn'] = 'unknown'
  account: AgentAccount | null = null
  limits = new Map<string, PlanLimit>()
  /** The capabilities of the last `initialize`, from this run or an earlier one. */
  initRecord: RememberedInit | null = null
  /** The account, limits and capabilities as last remembered, so only a change is written. */
  remembered = ''
  limitsRun: Promise<void> | null = null
  limitsReadAt = 0
  optionsRun: Promise<void> | null = null
  /** The removal of the hidden session that read the options, once its `session/new` answered. */
  optionsRemoval: Promise<void> | null = null
  progress = new TextRing(8 * 1024)
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

// A signed-out account is not kept: whether it is still signed out shows once the agent runs.
function rememberedEntry(slot: Slot): AgentsFile['agents'][AgentId] | null {
  const account = slot.account?.kind === 'none' ? null : slot.account
  const limits = [...slot.limits.values()]
  const init = slot.initRecord
  return account || limits.length > 0 || init
    ? { account, limits, ...(init ? { init } : {}) }
    : null
}

/**
 * An earlier run's capabilities, until the agent initializes again, while the adapter a start
 * would run is the version that reported them.
 */
function rememberedCapabilities(slot: Slot): RememberedInit['capabilities'] | undefined {
  const adapter = slot.detection?.state === 'available' ? slot.detection.adapter : null
  const version = (adapter?.current ?? adapter?.fallback)?.version
  return version !== undefined && slot.initRecord?.version === version
    ? slot.initRecord.capabilities
    : undefined
}

function rememberedJson(slot: Slot): string {
  return JSON.stringify(rememberedEntry(slot))
}

function updateJson(slot: Slot): string {
  return JSON.stringify(updateEntry(slot))
}

function updateEntry(slot: Slot): AgentUpdatesFile['agents'][AgentId] {
  if (slot.attemptedAt === null) return undefined
  return {
    checkedAt: slot.checkedAt,
    attemptedAt: slot.attemptedAt,
    latest: slot.latest,
    ...(slot.skipped ? { skipped: slot.skipped } : {}),
  }
}

/** Whether two updates name the same adapter and CLI versions. */
function sameUpdate(a: AgentUpdate | null, b: AgentUpdate | null): boolean {
  return !!a && !!b && a.adapterVersion === b.adapterVersion && a.cliVersion === b.cliVersion
}

export class AgentManager {
  private readonly slots = new Map<AgentId, Slot>()
  /** Processes their stop did not end, kept listed and reaped at quit until they exit. */
  private readonly givenUp = new Map<LaunchedAgent, Slot>()
  private readonly timings: AgentTimings
  private detected: Promise<void> | null = null
  private lastAuthCommands = '[]'
  private updateCheck: Promise<UpdateCheck> | null = null
  private updateCheckAll = false
  private updateAbort: AbortController | null = null
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** Whether this launch tried removing the archived Codex threads the reports left. */
  private reportThreadsTried = false
  private codexReportThreadsRemovedAt: number | null = null
  private readonly cliVersions: CliVersions
  hooks: AgentSessionHooks = {
    liveSessions: () => 0,
    agentExited: () => {},
    signedIn: () => {},
    optionsKnown: () => true,
    optionsSeen: () => {},
    configChanged: () => {},
  }

  constructor(private readonly deps: AgentManagerDeps) {
    this.timings = { ...AGENT_TIMINGS, ...deps.timings }
    this.cliVersions = deps.cliVersions ?? new CliVersions({ platform: deps.platform })
    for (const def of deps.catalog) this.slots.set(def.id, new Slot(def))
  }

  has(agentId: AgentId): boolean {
    return this.slots.has(agentId)
  }

  name(agentId: AgentId): string {
    return this.slots.get(agentId)?.def.name ?? agentId
  }

  mcpServersByName(agentId: AgentId): boolean {
    return this.slots.get(agentId)?.def.mcpServersByName ?? false
  }

  replaysThoughtParts(agentId: AgentId): boolean {
    return this.slots.get(agentId)?.def.replaysThoughtParts ?? false
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
    const agentSettings = this.deps.settings().agents[slot.def.id]
    const env = this.deps.env.agentEnv(slot.def.id)
    const node = this.deps.env.nodeProbe()
    const isExecutable = (file: string): Promise<boolean> => isExecutableFile(file, platform)
    const detection = await (this.deps.detect ?? detectAgent)(slot.def, {
      platform,
      env,
      electronPath: this.deps.electronPath,
      binaryOverride: agentSettings?.binaryPath ?? null,
      node,
      adaptersDir: this.deps.adaptersDir,
      isExecutable,
      probeCli: (program, cliEnv) => this.askVersion(program, cliEnv),
      cliPreference: agentSettings?.cli ?? 'installed',
      cliFailure: slot.cliFailure,
    })
    const adapter = detection.state === 'available' ? detection.adapter : null
    const running = adapter?.current ?? adapter?.fallback
    const log = (level: 'info' | 'warn' | 'error', message: string): void =>
      this.deps.diagnostics.log(level, message)
    const [installedCli, plans] = await Promise.all([
      running ? readCliVersion(slot.def.id, running.dir, log) : null,
      slot.def.installs
        ? installPlans(slot.def.installs, { platform, env, npm: node.npmPath, isExecutable })
        : [],
    ])
    slot.detection = detection
    slot.installedCli = installedCli
    slot.installPlans = plans
    // A binary agent's own version is asked in the background, so detection never waits for it.
    const program =
      slot.def.launch.kind === 'binary' && detection.state === 'available'
        ? (detection.spec?.command ?? null)
        : null
    if (program !== slot.binaryProgram) {
      slot.binaryProgram = program
      slot.binaryVersion = null
      slot.binaryVersionFailure = null
    }
    // A running, installing, failed or recovering agent keeps its lifecycle state.
    const idle = !slot.launched && !slot.starting && !slot.installing && slot.state !== 'failed'
    if (idle) {
      slot.state = detection.state
      slot.detail = detection.state === 'available' ? null : detection.detail
    }
    this.emit(slot)
    if (program) void this.askBinaryVersion(slot, program, env)
    this.removeReportThreadsOnce(slot, detection, env)
  }

  /**
   * The one-time removal of the archived Codex threads the plan limit reports left in its
   * history, at the first detection that finds Codex available in a launch: its own binary,
   * the `CODEX_PATH` its launch runs, listed and deleted through its app-server. A failure is
   * logged, and the next launch tries again.
   */
  private removeReportThreadsOnce(slot: Slot, detection: Detection, env: Env): void {
    if (slot.def.id !== 'codex' || detection.state !== 'available') return
    if (this.reportThreadsTried || this.codexReportThreadsRemovedAt !== null || this.stopped) return
    // Tried once a launch: without the binary the adapter would run through npm's `codex.js`.
    this.reportThreadsTried = true
    const binary = detection.spec?.env.CODEX_PATH ?? getEnv(env, 'CODEX_PATH', this.deps.platform)
    if (!binary) return
    void removeReportThreads({
      binary,
      env,
      reportsDir: this.deps.reportsDir,
      platform: this.deps.platform,
      version: this.deps.appVersion,
      log: (level, message) => this.deps.diagnostics.log(level, message),
    }).then(
      (count) => {
        this.codexReportThreadsRemovedAt = Date.now()
        this.remember()
        this.deps.diagnostics.log(
          'info',
          `Removed ${count} archived Codex thread${count === 1 ? '' : 's'} that its plan limit reports left; this runs once`,
        )
      },
      (error: unknown) => {
        this.deps.diagnostics.log(
          'warn',
          `Could not remove the archived Codex threads its plan limit reports left, so the next launch tries again: ${(error as Error).message}`,
        )
      },
    )
  }

  /** A program's `--version` answer: the test's probe, or the cache the CLIs are asked through. */
  private askVersion(program: string, env: Env): Promise<CliVersion> {
    return this.deps.probeCli
      ? this.deps.probeCli(program, env)
      : this.cliVersions.probe(program, env)
  }

  /**
   * A binary agent's version from `--version`, asked in the background as detection finds the
   * program: Settings shows it before the agent starts, and `initialize` reports its own after.
   */
  private async askBinaryVersion(slot: Slot, program: string, env: Env): Promise<void> {
    let answer: CliVersion
    try {
      answer = await this.askVersion(program, env)
    } catch (error) {
      answer = { error: (error as Error).message }
    }
    // A detection that moved on to another program has asked its own version.
    if (slot.binaryProgram !== program) return
    if ('error' in answer) {
      slot.binaryVersion = null
      // The same failure is logged once, however often detection asks again.
      if (slot.binaryVersionFailure !== answer.error) {
        slot.binaryVersionFailure = answer.error
        this.deps.diagnostics.log(
          'warn',
          `${slot.def.name}: could not read its version: ${answer.error}`,
        )
      }
    } else {
      slot.binaryVersion = answer.version
      slot.binaryVersionFailure = null
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
    this.cliVersions.clear()
    for (const slot of this.slots.values()) slot.cliFailure = null
    await Promise.all([...this.slots.values()].map((slot) => this.detect(slot)))
    return this.statuses()
  }

  /**
   * Binary overrides, the choice of CLI or the configuration folder changed: detect the affected
   * agents again. The environment already carries the new folder.
   */
  async settingsChanged(previous: HostSettings, next: HostSettings): Promise<void> {
    const before = (slot: Slot) => previous.agents[slot.def.id]
    const after = (slot: Slot) => next.agents[slot.def.id]
    const folderChanged = (slot: Slot) =>
      !!slot.def.configVariable && before(slot)?.configDir !== after(slot)?.configDir
    // Choosing again tries the installed CLI again, after a start with it failed.
    for (const slot of this.slots.values()) {
      if (before(slot)?.cli !== after(slot)?.cli) slot.cliFailure = null
    }
    // The account, limits and prepared session belong to the folder the agent ran with.
    for (const slot of this.slots.values()) {
      if (!folderChanged(slot)) continue
      slot.account = null
      slot.limits.clear()
      this.hooks.configChanged(slot.def.id)
    }
    // Detecting again rewrites each idle agent's guidance in the new language.
    const changed = [...this.slots.values()].filter(
      (slot) =>
        previous.locale !== next.locale ||
        before(slot)?.binaryPath !== after(slot)?.binaryPath ||
        before(slot)?.cli !== after(slot)?.cli ||
        folderChanged(slot),
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
    return this.start(slot, detection.spec)
  }

  /**
   * Launches `spec`, or installs the pinned adapter first when it is null. A launch with the
   * user's own CLI that fails is tried once more with the adapter's copy, for an adapter that
   * starts its CLI while it initializes; any other failure is the adapter's.
   */
  private async start(slot: Slot, spec: LaunchSpec | null): Promise<AgentRuntime> {
    const run = (async () => {
      const first = spec ?? (await this.installPackage(slot))
      try {
        return await this.launch(slot, first)
      } catch (error) {
        if (!first.cli || !slot.def.cli?.startsAtInitialize || this.stopped) throw error
        const reason = (error as Error).message
        slot.cliFailure = { path: first.cli, reason }
        this.deps.diagnostics.event(slot.def.id, 'cli failed', `${first.cli}: ${reason}`)
        await this.detect(slot)
        const copy = slot.detection?.state === 'available' ? slot.detection.spec : null
        return this.launch(slot, copy ?? (await this.installPackage(slot)))
      }
    })()
    slot.starting = run
    try {
      const runtime = await run
      this.cleanUpVersions(slot)
      this.sessionsChanged(slot.def.id)
      return runtime
    } catch (error) {
      const message = (error as Error).message
      // A start the quit stopped did not fail either.
      if (error instanceof InstallCancelled || this.stopped) {
        slot.state = slot.detection?.state ?? 'available'
        slot.detail = null
        this.emit(slot)
        throw new HostError('agent_unavailable', message, {
          agentId: slot.def.id,
          state: slot.state,
        })
      }
      this.recordFailure(slot)
      slot.state = 'failed'
      slot.detail = message
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
    if (this.stopped) throw new Error(`${slot.def.name} was not started: the host is stopping.`)
    slot.state = 'starting'
    slot.detail = null
    slot.progress.clear()
    slot.intentionalStop = false
    slot.launchSpec = spec
    const env = this.deps.env.agentEnv(agentId)
    slot.launchConfig = this.configIn(slot, env)
    this.emit(slot)
    diagnostics.event(agentId, 'start', formatCommand(spec.display, this.deps.platform))
    const launched = this.deps.launcher.launch(slot.def, spec, env, {
      stderr: (text) => this.onStderr(slot, text),
      event: (event, detail) => diagnostics.event(agentId, event, detail),
    })
    slot.launched = launched
    if (launched.pid !== null) {
      this.deps.trees?.launched({ pid: launched.pid, startedAt: launched.startedAt })
    }
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
      slot.initRecord = init.version
        ? { version: init.version, capabilities: { ...init.capabilities } }
        : null
      slot.runtime = runtime
      slot.state = 'ready'
      slot.detail = null
      diagnostics.event(agentId, 'ready', init.version ?? undefined)
      this.emit(slot)
      return runtime
    } catch (error) {
      slot.intentionalStop = true
      connection.close()
      const info = await launched.stop(this.tools())
      if (!launched.hasExited) this.letGo(slot, launched, info)
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
    void this.reapTree(slot, launched)
    connection.close()
    if (this.givenUp.delete(launched)) {
      this.emitProcesses()
      // Only while the agent runs, since launchSpec also matches a start that failed initialize.
      if (!this.stopped && !this.givenUpRuns(slot) && slot.runtime) this.cleanUpVersions(slot)
    }
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
    // Nothing restarts it: its sessions go back to closed, and the next one used starts it.
    this.hooks.agentExited(agentId, info)
    if (this.recordFailure(slot)) {
      slot.state = 'failed'
      slot.detail = t('agent.stoppedTooOften', {
        detail: t('agent.exited', { exit: exitText(slot.def.name, info) }),
        count: this.timings.maxFailures,
      })
    } else {
      slot.state = slot.detection?.state ?? 'available'
      slot.detail = null
    }
    this.emit(slot)
  }

  private recordFailure(slot: Slot): boolean {
    const now = Date.now()
    slot.failures = slot.failures.filter((at) => now - at < this.timings.failureWindowMs)
    slot.failures.push(now)
    return slot.failures.length >= this.timings.maxFailures
  }

  // Adapter installs.

  /**
   * Installs the pinned adapter, or the version asked for, and returns how to run the install a
   * start now picks. When the pinned one fails and an older version is installed, returns that one
   * instead and says so in the status.
   */
  private async installPackage(
    slot: Slot,
    request: { version?: string; alongside?: boolean; fallback?: boolean } = {},
  ): Promise<LaunchSpec> {
    if (this.stopped) {
      throw new InstallCancelled(`${slot.def.name} was not installed: the host is stopping.`)
    }
    const detection = slot.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    if (!detection || detection.state !== 'available' || !adapter) {
      throw new Error(`${slot.def.name} has no adapter to install.`)
    }
    const { diagnostics, platform } = this.deps
    const agentId = slot.def.id
    // The copy is needed where the install a start runs has none: that version again, with it.
    const copy = adapter.cli?.needsCopy ? adapter.current : null
    const version = request.version ?? copy?.version ?? adapter.version
    const withoutCli = !copy && adapter.cli?.runs === 'installed'
    slot.state = 'installing'
    slot.detail = null
    slot.progress.clear()
    this.emit(slot)
    const abort = new AbortController()
    slot.installAbort = abort
    const started = Date.now()
    diagnostics.event(agentId, 'install', `${adapter.package}@${version}`)
    try {
      if (!adapter.npm) throw new Error('npm was not found on PATH.')
      await (this.deps.install ?? installAdapter)({
        root: this.deps.adaptersDir,
        agentId,
        package: adapter.package,
        version,
        npm: adapter.npm,
        nodeVersion: adapter.nodeVersion,
        platform,
        env: this.deps.env.agentEnv(agentId),
        timeoutMs: this.timings.installMs,
        signal: abort.signal,
        onOutput: (text) => this.onProgress(slot, text),
        ...(request.alongside || copy ? { alongside: true } : {}),
        ...(withoutCli ? { withoutCli: true } : {}),
      })
      diagnostics.event(agentId, 'installed', `${version} in ${Date.now() - started} ms`)
      slot.adapterNote = null
      await this.detect(slot)
      const detected = slot.detection?.state === 'available' ? slot.detection : null
      // The user's CLI turned out older than the adapter just installed needs: the copy comes too.
      const copyToo = withoutCli && !detected?.spec && detected?.adapter?.cli?.needsCopy
      if (!copyToo) {
        const spec = detected?.spec ?? null
        if (!spec) throw new Error(`${adapter.package} ${version} is incomplete on disk.`)
        return spec
      }
      // A cancel that came while this install was being detected stops the copy before it starts.
      abort.signal.throwIfAborted()
    } catch (error) {
      const message = (error as Error).message
      diagnostics.event(agentId, 'install failed', message)
      const text = t('agent.installFailed', { agent: slot.def.name, message })
      if (abort.signal.aborted) throw new InstallCancelled(text, { cause: error })
      if (adapter.fallback && request.fallback !== false) {
        slot.adapterNote = t('agent.runningFallback', {
          fallback: adapter.fallback.version,
          version,
          message,
        })
        return adapter.fallback.spec
      }
      throw new Error(text, { cause: error })
    } finally {
      slot.installAbort = null
    }
    // Once this install has settled, so that the install of the copy holds the abort while it runs,
    // and its cancel or failure reaches the caller as its own.
    return this.installPackage(slot, request.fallback === false ? { fallback: false } : {})
  }

  /**
   * Once the install a start picks runs, the older installs go. A newer one, such as an update
   * that finished meanwhile, stays, and so does the install this process runs from. While a
   * process its stop gave up still runs, possibly from an older install, nothing goes until the
   * last one exits.
   */
  private cleanUpVersions(slot: Slot): void {
    const detection = slot.detection
    const { launch } = slot.def
    if (detection?.state !== 'available' || launch.kind !== 'package') return
    const current = detection.adapter?.current
    if (!current || !detection.spec || slot.launchSpec !== detection.spec) return
    if (slot.cleanedDir === current.dir) return
    if (this.givenUpRuns(slot)) return
    slot.cleanedDir = current.dir
    const agentId = slot.def.id
    removeOlderInstalls(this.deps.adaptersDir, agentId, launch.package, current).then(
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

  /** Refuses a second install or update while one runs. */
  private assertNoInstall(slot: Slot): void {
    if (slot.task?.state === 'running' || slot.installing || slot.state === 'installing') {
      throw new HostError('busy', t('agent.busyTask', { agent: slot.def.name }))
    }
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
    if (slot.task?.state === 'running') {
      throw new HostError('busy', t('agent.busyTask', { agent: slot.def.name }))
    }
    if (this.hooks.liveSessions(agentId) > 0) {
      throw new HostError('busy', t('agent.closeSessionsFirst', { agent: slot.def.name }))
    }
    const stillRunning = (): HostError =>
      new HostError('busy', t('agent.stillRunning', { agent: slot.def.name }))
    if (this.givenUpRuns(slot)) throw stillRunning()
    const run = (async () => {
      await this.detectAll()
      await this.stopProcess(slot)
      // A process its stop gave up may still run from the install, which must not go under it.
      if (this.givenUpRuns(slot)) throw stillRunning()
      // The install a start runs goes, and the same version comes back.
      const detected = slot.detection?.state === 'available' ? slot.detection.adapter : null
      const removed = detected?.current ?? null
      if (removed) await removeInstall(removed.dir)
      slot.failures = []
      slot.cleanedDir = null
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
        await this.installPackage(slot, {
          version: removed?.version ?? launch.version,
          alongside: true,
        })
        slot.state = 'available'
      } catch (error) {
        if (error instanceof InstallCancelled) {
          slot.state = slot.detection?.state ?? 'available'
          slot.detail = null
          return
        }
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

  // Updates and installs the user asks for.

  /**
   * The update to offer: what the last check found, against the install a start runs. An agent
   * that runs an install below the pin, because the pinned one could not be installed, is offered
   * the pin at least.
   */
  private updateOf(slot: Slot): AgentUpdate | null {
    const detection = slot.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    const running = adapter?.current ?? adapter?.fallback
    if (!adapter || !running) return null
    let offered = decideUpdate(slot.latest, {
      version: running.version,
      cliVersion: slot.installedCli,
    })
    // While the user's own CLI runs, only a newer adapter is an update; its CLI would not run,
    // unless the new adapter needs a newer CLI than the user's, which the update then brings.
    if (offered && adapter.cli?.runs === 'installed') {
      const mine = adapter.cli.installed
      const outgrown =
        !!slot.def.cli?.pinsVersion &&
        !!offered.cliVersion &&
        !!mine?.version &&
        !mine.variable &&
        compareVersions(mine.version, offered.cliVersion) < 0
      offered =
        compareVersions(offered.adapterVersion, running.version) > 0
          ? {
              adapterVersion: offered.adapterVersion,
              cliVersion: outgrown ? offered.cliVersion : null,
            }
          : null
    }
    if (adapter.current) return offered
    return offered && compareVersions(offered.adapterVersion, adapter.version) >= 0
      ? offered
      : { adapterVersion: adapter.version, cliVersion: null }
  }

  /** What an earlier run's update check found, so an update shows without the network. */
  restoreUpdates(file: AgentUpdatesFile): void {
    for (const [agentId, entry] of Object.entries(file.agents) as [
      AgentId,
      AgentUpdatesFile['agents'][AgentId],
    ][]) {
      const slot = this.slots.get(agentId)
      if (!slot || !entry || slot.def.launch.kind !== 'package') continue
      slot.latest = entry.latest
      slot.checkedAt = entry.checkedAt
      slot.attemptedAt = entry.attemptedAt
      slot.skipped = entry.skipped ?? null
      slot.rememberedUpdate = updateJson(slot)
      this.emit(slot)
    }
  }

  /**
   * Checks each agent once its last check, found or failed, is a day old, but no sooner than a
   * minute after start. Called once the first detection is done, and again after each check.
   */
  scheduleUpdateChecks(): void {
    if (this.updateTimer || this.stopped) return
    const slots = this.checkable()
    if (slots.length === 0) return
    const next = Math.min(...slots.map((slot) => this.checkDue(slot)))
    const delayMs = Math.max(this.timings.updateDelayMs, next - Date.now())
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null
      void this.runUpdateCheck(false).then(() => this.scheduleUpdateChecks())
    }, delayMs)
    this.updateTimer.unref?.()
  }

  /** The package agents whose npm was found, which a check can ask about. */
  private checkable(): Slot[] {
    return [...this.slots.values()].filter(
      (slot) =>
        slot.def.launch.kind === 'package' &&
        slot.detection?.state === 'available' &&
        slot.detection.adapter?.npm,
    )
  }

  private checkDue(slot: Slot): number {
    return (slot.attemptedAt ?? 0) + this.timings.updateIntervalMs
  }

  /**
   * The user's check (`all`) asks about every agent; the daily one only about those due, so an
   * agent whose check keeps failing waits a day like the others. Never rejects, and a failure
   * keeps the last result. A user's check during a daily one runs after it.
   */
  private runUpdateCheck(all: boolean): Promise<UpdateCheck> {
    if (this.updateCheck && (this.updateCheckAll || !all)) return this.updateCheck
    const before = this.updateCheck
    const run: Promise<UpdateCheck> = (async () => {
      await before
      await this.detectAll()
      if (this.stopped) return { checked: 0, failures: [] }
      const abort = new AbortController()
      this.updateAbort = abort
      const now = Date.now()
      const slots = this.checkable().filter((slot) => all || this.checkDue(slot) <= now)
      const results = await Promise.all(slots.map((slot) => this.checkSlot(slot, abort.signal)))
      return { checked: slots.length, failures: results.filter((r) => r !== null) }
    })().finally(() => {
      if (this.updateCheck !== run) return
      this.updateCheck = null
      this.updateCheckAll = false
      this.updateAbort = null
    })
    this.updateCheck = run
    this.updateCheckAll = all
    return run
  }

  private async checkSlot(slot: Slot, signal: AbortSignal): Promise<string | null> {
    const { launch } = slot.def
    const adapter = slot.detection?.state === 'available' ? slot.detection.adapter : null
    if (launch.kind !== 'package' || !adapter?.npm) return null
    try {
      const latest = await (this.deps.fetchLatest ?? fetchLatest)({
        npm: adapter.npm,
        package: launch.package,
        cli: CLI_VERSION_SOURCES[slot.def.id] ?? null,
        env: this.deps.env.agentEnv(slot.def.id),
        platform: this.deps.platform,
        cwd: os.homedir(),
        timeoutMs: this.timings.updateViewMs,
        signal,
      })
      slot.latest = latest
      slot.checkedAt = Date.now()
      slot.attemptedAt = slot.checkedAt
      const cli = latest.cliVersion ? `, CLI ${latest.cliVersion}` : ''
      this.deps.diagnostics.event(slot.def.id, 'update check', `${latest.adapterVersion}${cli}`)
      this.emit(slot)
      return null
    } catch (error) {
      const message = (error as Error).message
      this.deps.diagnostics.log('warn', `${slot.def.name}: the update check failed: ${message}`)
      slot.attemptedAt = Date.now()
      this.emit(slot)
      return message
    }
  }

  /** The user's check: resolves with the statuses, or rejects when no agent could be checked. */
  async checkUpdates(): Promise<AgentStatus[]> {
    const { checked, failures } = await this.runUpdateCheck(true)
    if (checked === 0) throw new HostError('agent_unavailable', t('agent.update.noNpm'))
    if (failures.length === checked) {
      throw new HostError('agent_error', t('agent.update.checkFailed', { reason: failures[0] }))
    }
    return this.statuses()
  }

  /**
   * Installs the update beside the install that runs now, which keeps running; a start after it
   * runs the new one. Resolves when done or cancelled; a failure leaves the old install as it was.
   */
  async update(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    const { launch } = slot.def
    if (launch.kind !== 'package') {
      throw invalidParams(`${slot.def.name} is not installed by OverBench`)
    }
    await this.detectAll()
    const update = this.updateOf(slot)
    if (!update) throw invalidParams(t('agent.update.none', { agent: slot.def.name }))
    this.assertNoInstall(slot)
    const adapter = slot.detection?.state === 'available' ? slot.detection.adapter : null
    const npm = adapter?.npm
    if (!adapter || !npm) {
      throw new HostError(
        'agent_unavailable',
        t('detect.npmMissing', { agent: slot.def.name, hint: t(slot.def.install.hint) }),
      )
    }
    const { platform, diagnostics } = this.deps
    const version = update.adapterVersion
    // An update that brings no CLI of its own keeps running the user's.
    const withoutCli = adapter.cli?.runs === 'installed' && update.cliVersion === null
    const [, ...flags] = withoutCli ? [...NPM_INSTALL_ARGS, OMIT_CLI_ARG] : NPM_INSTALL_ARGS
    const command = formatCommand(
      { command: npm, args: ['install', `${launch.package}@${version}`, ...flags] },
      platform,
    )
    await this.runTask(
      slot,
      'update',
      command,
      async (signal, onOutput) => {
        const started = Date.now()
        diagnostics.event(agentId, 'update', `${launch.package}@${version}`)
        const installed = await (this.deps.install ?? installAdapter)({
          root: this.deps.adaptersDir,
          agentId,
          package: launch.package,
          version,
          npm,
          nodeVersion: adapter.nodeVersion,
          platform,
          env: this.deps.env.agentEnv(agentId),
          timeoutMs: this.timings.installMs,
          signal,
          onOutput,
          alongside: true,
          ...(withoutCli ? { withoutCli: true } : {}),
        })
        diagnostics.event(agentId, 'updated', `${installed.version} in ${Date.now() - started} ms`)
        await this.detect(slot)
        slot.skipped = null
        // A fresh install can take another CLI than the check foresaw; what it took is the latest.
        if (this.updateOf(slot)) {
          slot.latest = { adapterVersion: installed.version, cliVersion: slot.installedCli }
        }
      },
      (message) => t('agent.updateFailed', { agent: slot.def.name, message }),
    )
  }

  /**
   * Skips the agent's current update in the sidebar's notice, until a newer adapter or CLI is
   * found. Installing an update clears the skip.
   */
  async skipUpdate(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    const update = this.updateOf(slot)
    // The update can be gone by the time the click arrives, as when it installed meanwhile.
    if (!update) return
    slot.skipped = update
    this.emit(slot)
  }

  /**
   * Installs an agent that is missing: a package agent's pinned adapter now, without starting it,
   * or a binary agent by one of its routes. Resolves when done or cancelled.
   */
  async install(agentId: AgentId, method?: AgentInstallMethod['id']): Promise<void> {
    const slot = this.slot(agentId)
    await this.detectAll()
    switch (slot.def.launch.kind) {
      case 'package':
        return this.installNow(slot)
      case 'binary':
        return this.installBinary(slot, method)
      case 'node-script':
        throw invalidParams(`${slot.def.name} is not installed by OverBench`)
    }
  }

  /** The first-use install, shared with any start that waits for it. */
  private async installNow(slot: Slot): Promise<void> {
    const agentId = slot.def.id
    if (slot.installing) {
      await slot.installing
      return
    }
    if (!slot.starting && slot.detection?.state !== 'available') await this.detect(slot)
    const detection = slot.detection
    if (detection?.state !== 'available') {
      throw new HostError(
        'agent_unavailable',
        detection?.detail ?? t('agent.cannotInstall', { agent: slot.def.name }),
        { agentId, state: detection?.state ?? 'not-installed' },
      )
    }
    if (detection.adapter?.installed) return
    // A start that installs first.
    if (slot.starting) {
      await slot.starting
      return
    }
    this.assertNoInstall(slot)
    const run = (async () => {
      try {
        await this.installPackage(slot, { fallback: false })
        slot.state = 'available'
      } catch (error) {
        if (error instanceof InstallCancelled) {
          slot.state = slot.detection?.state ?? 'available'
          slot.detail = null
          return
        }
        const message = (error as Error).message
        // An older install still runs, so the agent stays usable and only this install failed.
        if (detection.adapter?.fallback) {
          slot.state = slot.detection?.state ?? 'available'
          slot.detail = null
          throw new HostError('agent_error', message, { agentId })
        }
        slot.state = 'failed'
        slot.detail = message
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

  private async installBinary(
    slot: Slot,
    methodId: AgentInstallMethod['id'] | undefined,
  ): Promise<void> {
    const installs = slot.def.installs
    const agent = slot.def.name
    if (!installs) throw invalidParams(`${agent} is not installed by OverBench`)
    if (slot.detection?.state === 'available') {
      throw invalidParams(t('agent.alreadyInstalled', { agent }))
    }
    const plan = methodId
      ? slot.installPlans.find((candidate) => candidate.id === methodId)
      : slot.installPlans.find((candidate) => candidate.available)
    if (!plan) {
      throw invalidParams(
        methodId
          ? `${agent} has no ${methodId} install on this platform`
          : t('agent.binaryInstall.noMethod', { agent }),
      )
    }
    const run = plan.run
    if (!plan.available || !run) {
      throw invalidParams(t('agent.binaryInstall.unavailable', { command: plan.command }))
    }
    this.assertNoInstall(slot)
    const { platform, diagnostics } = this.deps
    const home = os.homedir()
    const timeoutMs = this.timings.installMs
    await this.runTask(
      slot,
      'install',
      plan.command,
      async (signal, onOutput) => {
        diagnostics.event(slot.def.id, 'install', plan.command)
        const result = await (this.deps.runProgram ?? runProgram)({
          program: run.program,
          args: run.args,
          cwd: home,
          env: this.deps.env.agentEnv(slot.def.id),
          platform,
          timeoutMs,
          signal,
          onOutput,
        })
        const name = path.basename(run.program).replace(/\.(?:cmd|exe)$/i, '')
        const failure = programFailure(name, result, timeoutMs)
        if (failure) throw new Error(failure)
        // The script adds its folder to PATH in shell startup files, which a new login shell reads.
        await this.deps.env.reload()
        await Promise.all([...this.slots.values()].map((other) => this.detect(other)))
        if (slot.detection?.state === 'available') return
        const folder = await installedFolder(plan, installs, {
          platform,
          home,
          npmPrefix: () => this.npmPrefix(plan.tool),
        })
        const command = slot.def.launch.kind === 'binary' ? slot.def.launch.command : agent
        throw new Error(
          folder
            ? t('agent.binaryInstall.notOnPath', { agent, command, folder })
            : t('agent.binaryInstall.notFound', { agent, command }),
        )
      },
      (message) => t('agent.installFailed', { agent, message }),
      plan.id,
    )
  }

  /** `npm prefix -g`, the folder global installs go to; null when npm does not say. */
  private async npmPrefix(npm: string | null): Promise<string | null> {
    if (!npm) return null
    const run = await (this.deps.runProgram ?? runProgram)({
      program: npm,
      args: ['prefix', '-g'],
      cwd: os.homedir(),
      env: this.deps.env.agentEnv(),
      platform: this.deps.platform,
      timeoutMs: this.timings.updateViewMs,
    })
    const prefix = run.code === 0 ? run.stdout.trim() : ''
    return prefix === '' ? null : prefix
  }

  /** Runs an install or update as the agent's task, with its progress, failure and cancel. */
  private async runTask(
    slot: Slot,
    kind: AgentTask['kind'],
    command: string,
    work: (signal: AbortSignal, onOutput: (text: string) => void) => Promise<void>,
    failure: (message: string) => string,
    method: AgentTask['method'] = null,
  ): Promise<void> {
    // Nothing installs once the quit has begun, as though cancelled at once.
    if (this.stopped) return
    const abort = new AbortController()
    slot.taskOutput.clear()
    slot.task = { kind, state: 'running', command, method, error: null }
    slot.taskAbort = abort
    this.emit(slot)
    const run = (async () => {
      try {
        await work(abort.signal, (text) => this.onTaskOutput(slot, text))
        slot.task = null
      } catch (error) {
        if (abort.signal.aborted) {
          slot.task = null
          return
        }
        const message = failure((error as Error).message)
        this.deps.diagnostics.event(slot.def.id, `${kind} failed`, message)
        slot.task = { kind, state: 'failed', command, method, error: message }
        throw new HostError('agent_error', message, { agentId: slot.def.id })
      } finally {
        slot.taskAbort = null
        this.emit(slot)
      }
    })()
    slot.taskRun = run
    try {
      await run
    } finally {
      if (slot.taskRun === run) slot.taskRun = null
    }
  }

  /**
   * Stops a running install or update, its process tree and its partial directory included, or
   * clears one that failed. Resolves once it has stopped.
   */
  async cancelTask(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    if (slot.task?.state === 'failed') {
      slot.task = null
      this.emit(slot)
      return
    }
    if (slot.task?.state === 'running') {
      slot.taskAbort?.abort()
      await slot.taskRun?.catch(() => {})
      return
    }
    // A package agent's first-use install, whether a start or Install asked for it.
    if (slot.installAbort) {
      slot.installAbort.abort()
      await Promise.all([slot.installing?.catch(() => {}), slot.starting?.catch(() => {})])
    }
  }

  /**
   * A failed task whose aim was reached some other way: the agent was installed meanwhile, such as
   * by a program picked in Settings, or the update it was for is no longer offered.
   */
  private taskSettled(slot: Slot): boolean {
    if (slot.task?.kind === 'update') return this.updateOf(slot) === null
    const adapter = slot.detection?.state === 'available' ? slot.detection.adapter : null
    return slot.detection?.state === 'available' && (!adapter || !!adapter.current)
  }

  private onTaskOutput(slot: Slot, text: string): void {
    this.deps.diagnostics.stderr(slot.def.id, text)
    slot.taskOutput.push(text)
    slot.progressTimer ??= setTimeout(() => {
      slot.progressTimer = null
      this.emit(slot)
    }, this.timings.progressMs)
  }

  /** Clears `failed` and starts the agent again when live sessions need it. */
  async retry(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    if (slot.state === 'failed') {
      slot.failures = []
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
    slot.installAbort?.abort(this.stopped ? QUIT_REASON : undefined)
    if (slot.installing) await slot.installing.catch(() => {})
    await this.stopProcess(slot)
  }

  /**
   * Stops the agent's process, after a start in progress settles. A quit does not wait for a
   * start that has launched its process, up to 30 s of `initialize`: it stops that process now.
   */
  private async stopProcess(slot: Slot): Promise<void> {
    for (const timer of [slot.idleTimer, slot.progressTimer]) {
      if (timer) clearTimeout(timer)
    }
    slot.idleTimer = slot.progressTimer = null
    if (slot.starting && !(this.stopped && slot.launched)) await slot.starting.catch(() => {})
    // The hidden session that read the options goes before the agent does. Only its removal is
    // waited for, not a `session/new` still unanswered, whose late answer is removed anyway.
    if (slot.optionsRemoval) await settledWithin(slot.optionsRemoval, REMOVAL_WAIT_MS)
    const launched = slot.launched
    if (!launched) return
    slot.intentionalStop = true
    slot.state = 'stopping'
    this.emit(slot)
    slot.stopping = this.noteTree(launched)
      .then(() => launched.stop(this.tools()))
      .then((info) => {
        if (!launched.hasExited) this.letGo(slot, launched, info)
        return this.reapTree(slot, launched)
      })
    try {
      await slot.stopping
    } finally {
      slot.stopping = null
    }
  }

  /** Whether a process of the agent that its stop gave up still runs. */
  private givenUpRuns(slot: Slot): boolean {
    return [...this.givenUp].some(([launched, owner]) => owner === slot && !launched.hasExited)
  }

  /**
   * Gives up a process its stop did not end, such as one whose `taskkill` failed: its stdin is
   * closed, so its runtime is never handed out again, and the next start runs a new process. It
   * stays listed for main until it exits, and its tree is stopped once more now and at quit.
   */
  private letGo(slot: Slot, launched: LaunchedAgent, info: ExitInfo): void {
    if (slot.launched !== launched) return
    const { diagnostics } = this.deps
    diagnostics.event(slot.def.id, 'stop failed', describeExit(info))
    diagnostics.log('warn', `${slot.def.name} did not stop: ${describeExit(info)}`)
    slot.runtime?.connection.close()
    slot.launched = null
    slot.runtime = null
    this.givenUp.set(launched, slot)
    this.emitProcesses()
    void this.reapTree(slot, launched)
    // A start that failed reports itself.
    if (slot.starting) return
    slot.state = slot.detection?.state ?? 'available'
    slot.detail = null
    this.emit(slot)
  }

  /** Only a quit is short of time, and only it gets the process tools' short limits. */
  private tools(): ToolOptions {
    return { quitting: this.stopped }
  }

  private noteTree(launched: LaunchedAgent): Promise<void> {
    const { trees } = this.deps
    if (!trees || launched.pid === null || launched.hasExited) return Promise.resolve()
    return trees.note({ pid: launched.pid, startedAt: launched.startedAt }, this.tools())
  }

  /** What the agent's process left behind once it exited: CLIs, servers, commands it ran. */
  private reapTree(slot: Slot, launched: LaunchedAgent): Promise<void> {
    const { trees } = this.deps
    if (!trees || launched.pid === null) return Promise.resolve()
    const root = { pid: launched.pid, startedAt: launched.startedAt }
    return trees.reap(root, slot.def.name, this.tools())
  }

  /**
   * Stops every agent in parallel, with the documented sequence, and every task and check, for a
   * quit. After `quitStopMs` it kills what still runs instead, so that the host still writes its
   * state before main kills it; what that misses stays in the process record for the next host.
   */
  async stopAll(): Promise<void> {
    this.stopped = true
    if (this.updateTimer) clearTimeout(this.updateTimer)
    this.updateTimer = null
    this.updateAbort?.abort(QUIT_REASON)
    const slots = [...this.slots.values()]
    for (const slot of slots) slot.taskAbort?.abort(QUIT_REASON)
    const stops = Promise.all([
      this.updateCheck,
      ...slots.map((slot) => slot.taskRun?.catch(() => {})),
      ...slots.map((slot) => this.stop(slot.def.id)),
      ...[...this.givenUp].map(([launched, slot]) => this.reapTree(slot, launched)),
    ]).then(() => true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.timings.quitStopMs)
    })
    const stopped = await Promise.race([stops, late])
    clearTimeout(timer)
    if (stopped) return
    const running = [...slots.map((slot) => [slot.launched, slot] as const), ...this.givenUp]
    await Promise.all(
      running.map(([launched, slot]) => {
        if (!launched || launched.hasExited) return
        this.deps.diagnostics.log(
          'warn',
          `${slot.def.name} had not stopped ${this.timings.quitStopMs / 1000} s into the quit; killing it`,
        )
        return launched.kill()
      }),
    )
  }

  // Sign-in, account and limits.

  private connectionHooks(slot: Slot): ConnectionHooks {
    const { diagnostics } = this.deps
    const agentId = slot.def.id
    return {
      traffic: (direction, message) => {
        diagnostics.traffic(agentId, direction, message)
        const { launched } = slot
        if (launched?.pid != null) {
          this.deps.trees?.active({ pid: launched.pid, startedAt: launched.startedAt })
        }
      },
      account: (account) => this.setAccount(slot, account),
      ignored: (sessionId, what) =>
        diagnostics.event(agentId, 'ignored', sessionId ? `${what} (session ${sessionId})` : what),
      log: (level, message) => diagnostics.log(level, `${slot.def.name}: ${message}`),
    }
  }

  private setAccount(slot: Slot, account: AgentAccount): void {
    const wasRequired = slot.signIn === 'required'
    const before = slot.account
    const same =
      before?.kind === account.kind &&
      before.label === account.label &&
      before.email === account.email
    slot.account = same && before.tier ? { ...account, tier: before.tier } : account
    slot.signIn = account.kind === 'none' ? 'required' : 'signed-in'
    this.emit(slot)
    if (wasRequired && slot.signIn === 'signed-in') this.hooks.signedIn(slot.def.id)
    if (slot.def.id === 'claude-code' && account.kind === 'account') {
      void this.readTier(slot, slot.account)
    }
  }

  /** Adds the subscription's tier, which only Claude Code's own `.claude.json` holds. */
  private async readTier(slot: Slot, account: AgentAccount): Promise<void> {
    const { platform } = this.deps
    const env = this.deps.env.agentEnv(slot.def.id)
    const folder = configLocations(
      slot.def.id,
      (name) => getEnv(env, name, platform),
      os.homedir(),
      platform,
      this.chosenFolder(slot),
    ).find((location) => location.id === 'folder')
    if (!folder) return
    const file = claudeJsonPath(folder, os.homedir(), platform)
    const tier = await readPlanTier(file, (level, message) =>
      this.deps.diagnostics.log(level, message),
    )
    // The account may have changed, or the agent been stopped and its account forgotten, meanwhile.
    if (slot.account !== account || (account.tier ?? null) === tier) return
    slot.account = { kind: account.kind, label: account.label, email: account.email }
    if (tier) slot.account.tier = tier
    this.emit(slot)
  }

  /** The plan limits the agent reported last, one per window. */
  limitsOf(agentId: AgentId): PlanLimit[] {
    return [...(this.slots.get(agentId)?.limits.values() ?? [])]
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
   * Reads the current use of every plan limit from the agent's report (`/usage`, `/status`), at
   * most once a minute, starting the agent if needed; the windows arrive in its status. Rate-limit
   * events report a window only when it changes, so without this most windows would stay unknown.
   */
  async refreshLimits(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    const report = limitsReport(agentId)
    if (!report) return
    await this.detectAll()
    if (slot.signIn === 'required' || (!slot.runtime && slot.detection?.state !== 'available')) {
      return
    }
    if (slot.limitsRun) return slot.limitsRun
    if (Date.now() - slot.limitsReadAt < this.timings.limitsMs) return
    slot.limitsRun = this.readLimits(slot, report).finally(() => {
      slot.limitsRun = null
    })
    return slot.limitsRun
  }

  private async readLimits(slot: Slot, report: LimitsReport): Promise<void> {
    const runtime = await this.ensureReady(slot.def.id)
    const dir = this.deps.reportsDir
    await mkdir(dir, { recursive: true })
    const log = (message: string): void => this.deps.diagnostics.log('warn', message)
    let messages: string[]
    try {
      messages = await runReport(
        runtime,
        async () => {
          const setup = await runtime.connection.newSession(dir, hiddenSessionMeta(slot.def.id))
          // Only while none are known: the empty folder's defaults never replace a session's.
          if (!this.hooks.optionsKnown(slot.def.id))
            this.hooks.optionsSeen(slot.def.id, setup.config, dir)
          return setup.acpSessionId
        },
        report,
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
      .map((text) => report.parse(text, now))
      .findLast((parsed) => parsed !== null)
    if (!limits) {
      log(`${slot.def.name}: ${report.command} gave no report OverBench can read`)
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

  /**
   * Reads a running agent's config options for the agent menu again, from `session/new` in a
   * hidden session in `folder`, or in the hidden folder, that is removed at once. An agent that is
   * not running is not started for it, and only one whose hidden sessions can be removed without
   * a trace is read. Never rejects: a failure, or no answer within `optionsMs`, is logged.
   */
  readOptions(agentId: AgentId, folder?: string): Promise<void> {
    const slot = this.slot(agentId)
    slot.optionsRun ??= this.openForOptions(slot, folder).finally(() => {
      slot.optionsRun = null
    })
    return slot.optionsRun
  }

  private async openForOptions(slot: Slot, folder: string | undefined): Promise<void> {
    const agentId = slot.def.id
    const log = (message: string): void =>
      this.deps.diagnostics.log('warn', `${slot.def.name}: ${message}`)
    // A limits report running meanwhile reads them too.
    await slot.limitsRun?.catch(() => {})
    if (slot.signIn === 'required') return
    const runtime = this.runtime(agentId)
    const removal = runtime && hiddenRemoval(agentId, runtime.init)
    if (!runtime || !removal) return
    try {
      await this.readInHiddenSession(slot, runtime, removal, log, folder)
    } catch (error) {
      if (error instanceof AgentRequestError && error.kind === 'auth_required') {
        this.authRequired(agentId)
        return
      }
      log(`could not read its options: ${agentError(error).message}`)
    }
  }

  /** `session/new` in the folder, bounded by `optionsMs`, then the session's removal. */
  private async readInHiddenSession(
    slot: Slot,
    runtime: AgentRuntime,
    removal: Removal,
    log: (message: string) => void,
    folder: string | undefined,
  ): Promise<void> {
    const agentId = slot.def.id
    const remove = (acpSessionId: string): Promise<void> =>
      removeHiddenSession(runtime, acpSessionId, removal, (message) =>
        log(`could not remove the session its options were read in: ${message}`),
      )
    const dir = folder ?? this.deps.reportsDir
    if (!folder) await mkdir(dir, { recursive: true })
    const opening = runtime.connection.newSession(dir, hiddenSessionMeta(agentId))
    let timer: ReturnType<typeof setTimeout> | null = null
    const setup = await Promise.race([
      opening,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.timings.optionsMs)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    if (!setup) {
      log(`gave no options within ${this.timings.optionsMs / 1000} s`)
      // A late answer still opened a session, which goes like any other.
      void opening.then(
        (late) => remove(late.acpSessionId),
        () => {},
      )
      return
    }
    try {
      if (setup.config.length > 0) this.hooks.optionsSeen(agentId, setup.config, dir)
      this.signedIn(agentId)
    } finally {
      const removing = remove(setup.acpSessionId)
      slot.optionsRemoval = removing
      try {
        await removing
      } finally {
        slot.optionsRemoval = null
      }
    }
  }

  /** Where the agent reads its configuration and which CLI its adapter runs, for its page. */
  async details(agentId: AgentId): Promise<AgentDetails> {
    const slot = this.slot(agentId)
    await this.detectAll()
    const { launch } = slot.def
    const adapter = slot.detection?.state === 'available' ? slot.detection.adapter : null
    // The install in use, as for diagnostics: the one a start picks, or the fallback until then.
    const inUse = adapter?.current?.dir ?? adapter?.fallback?.dir
    return readAgentDetails(agentId, {
      getEnv: (name) => this.deps.env.get(name, agentId),
      chosen: this.chosenFolder(slot),
      home: os.homedir(),
      platform: this.deps.platform,
      adapterDir:
        launch.kind === 'package'
          ? (inUse ?? path.join(this.deps.adaptersDir, agentId, launch.version))
          : null,
      log: (level, message) => this.deps.diagnostics.log(level, message),
    })
  }

  /** What the agents reported in an earlier run, shown until each reports again. */
  restore(file: AgentsFile): void {
    this.codexReportThreadsRemovedAt = file.codexReportThreadsRemovedAt ?? null
    for (const [agentId, entry] of Object.entries(file.agents) as [
      AgentId,
      AgentsFile['agents'][AgentId],
    ][]) {
      const slot = this.slots.get(agentId)
      if (!slot || !entry) continue
      slot.account = entry.account
      slot.limits = new Map(entry.limits.map((limit) => [limit.window, limit]))
      slot.initRecord = entry.init ?? null
      slot.remembered = rememberedJson(slot)
      this.emit(slot)
    }
  }

  /**
   * Brings an agent's account and plan limits up to date for Settings › Agents, starting an agent
   * that reports them. Never installs: an agent that would need an install first is left alone.
   */
  async refreshAccount(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    if (!slot.def.reportsAccount) return
    await this.detectAll()
    if (slot.signIn === 'required') return
    if (!slot.runtime && (slot.detection?.state !== 'available' || !slot.detection.spec)) return
    if (limitsReport(agentId)) await this.refreshLimits(agentId)
    else await this.ensureReady(agentId)
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
    slot.account = null
    slot.limits.clear()
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

  /** The folder picked in Settings for an agent whose folder can be moved. */
  private chosenFolder(slot: Slot): string | null {
    const folder = this.deps.settings().agents[slot.def.id]?.configDir
    return slot.def.configVariable && folder ? folder : null
  }

  /** The configuration folder `env` gives the agent; null for an agent whose folder is fixed. */
  private configIn(slot: Slot, env: Env): RunningConfig | null {
    if (!slot.def.configVariable) return null
    const { platform } = this.deps
    const chosen = this.chosenFolder(slot)
    const locations = configLocations(
      slot.def.id,
      (name) => getEnv(env, name, platform),
      os.homedir(),
      platform,
      chosen,
    )
    const folder = locations.find((location) => location.id === 'folder')?.candidates[0]
    return folder === undefined ? null : { folder, chosen }
  }

  private running(slot: Slot): boolean {
    return slot.state === 'ready' || slot.state === 'starting'
  }

  /** The configuration folder of the agent's running process; null while none runs. */
  runningConfig(agentId: AgentId): RunningConfig | null {
    const slot = this.slots.get(agentId)
    return slot && this.running(slot) ? slot.launchConfig : null
  }

  /** The configuration folder the environment gives the agent, without one picked in Settings. */
  environmentConfig(agentId: AgentId): string | null {
    const slot = this.slots.get(agentId)
    if (!slot?.def.configVariable) return null
    const { platform } = this.deps
    const env = this.deps.env.agentEnv()
    const locations = configLocations(
      agentId,
      (name) => getEnv(env, name, platform),
      os.homedir(),
      platform,
    )
    return locations.find((location) => location.id === 'folder')?.candidates[0] ?? null
  }

  /** The CLI the running adapter process uses, which a change of setting leaves until it stops. */
  private activeCli(slot: Slot, installed: InstalledCli | null): AgentCliSource | null {
    const spec = slot.state === 'ready' || slot.state === 'starting' ? slot.launchSpec : null
    if (!spec) return null
    // A program the environment names runs whatever OverBench passes.
    return spec.cli !== undefined || installed?.variable ? 'installed' : 'bundled'
  }

  status(agentId: AgentId): AgentStatus {
    const slot = this.slot(agentId)
    const platform = this.deps.platform
    const display = this.display(slot)
    const init = slot.init
    const config = this.configIn(slot, this.deps.env.agentEnv(agentId))
    const active = this.running(slot) ? slot.launchConfig : null
    // The sign-in runs in a terminal without the folder, so its command carries the one in use.
    const signInFolder = (active ?? config)?.chosen
    const folderEnv: Record<string, string> =
      signInFolder && slot.def.configVariable ? { [slot.def.configVariable]: signInFolder } : {}
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
                env: { ...display.env, ...method.env, ...folderEnv },
              },
              platform,
            ),
          }
        : {}),
    }))
    const capabilities = init?.capabilities ?? rememberedCapabilities(slot)
    const { launch } = slot.def
    const adapter = slot.detection?.state === 'available' ? slot.detection.adapter : null
    const update = this.updateOf(slot)
    return {
      id: slot.def.id,
      name: slot.def.name,
      state: slot.state,
      version: init?.version ?? slot.binaryVersion ?? null,
      package:
        launch.kind === 'package'
          ? {
              name: launch.package,
              version: (adapter?.current ?? adapter?.fallback)?.version ?? launch.version,
              // An install below the pin runs too, when the pinned one cannot be installed.
              installed: !!(adapter?.current ?? adapter?.fallback),
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
      update,
      updateCheckedAt: launch.kind === 'package' ? slot.checkedAt : null,
      updateSkipped: sameUpdate(update, slot.skipped),
      task: slot.task ? { ...slot.task, progress: slot.taskOutput.lastLines(5) } : null,
      installMethods: slot.installPlans.map(({ id, command, available }) => ({
        id,
        command,
        available,
      })),
      cli:
        adapter?.cli && slot.def.cli
          ? {
              command: slot.def.cli.command,
              prefer: this.deps.settings().agents[slot.def.id]?.cli ?? 'installed',
              runs: adapter.cli.runs,
              active: this.activeCli(slot, adapter.cli.installed),
              installed: adapter.cli.installed,
              needsCopy: adapter.cli.needsCopy,
              copyMegabytes: slot.def.cli.copyMegabytes,
            }
          : null,
      configDir: config ? { runs: config.folder, active: active?.folder ?? null } : null,
      capabilities: {
        loadSession: capabilities?.loadSession ?? false,
        listSessions: capabilities?.listSessions ?? false,
        resumeSession: capabilities?.resumeSession ?? false,
        closeSession: capabilities?.closeSession ?? false,
        deleteSession: capabilities?.deleteSession ?? false,
        forkSession: capabilities?.forkSession ?? false,
        forkAtMessage: capabilities?.forkAtMessage ?? false,
        // codex-acp 2.2.2 ignores `idleBehavior` and starts a turn of its own when none is
        // running (its PR #593 would fix it), which OverBench would not know about.
        steering: (capabilities?.steering ?? false) && slot.def.id !== 'codex',
        reports: limitsReport(slot.def.id) !== null,
        account: slot.def.reportsAccount ?? false,
        progressNotes: slot.def.progressNotes ?? false,
        prompt: capabilities?.prompt ?? null,
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
    const dir = adapter.current?.dir ?? adapter.fallback?.dir
    return dir ? readInstallFiles(dir) : null
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
    if (slot.task?.state === 'failed' && this.taskSettled(slot)) slot.task = null
    const status = this.status(slot.def.id)
    const json = JSON.stringify(status)
    if (json !== slot.lastStatus) {
      slot.lastStatus = json
      this.deps.status(status)
    }
    const remembered = rememberedJson(slot)
    if (remembered !== slot.remembered) {
      slot.remembered = remembered
      this.remember()
    }
    const update = updateJson(slot)
    if (update !== slot.rememberedUpdate) {
      slot.rememberedUpdate = update
      this.rememberUpdates()
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

  private remember(): void {
    if (!this.deps.remember) return
    const agents: AgentsFile['agents'] = {}
    for (const [agentId, slot] of this.slots) {
      const entry = rememberedEntry(slot)
      if (entry) agents[agentId] = entry
    }
    this.deps.remember({
      version: 1,
      agents,
      ...(this.codexReportThreadsRemovedAt === null
        ? {}
        : { codexReportThreadsRemovedAt: this.codexReportThreadsRemovedAt }),
    })
  }

  private rememberUpdates(): void {
    if (!this.deps.rememberUpdates) return
    const agents: AgentUpdatesFile['agents'] = {}
    for (const [agentId, slot] of this.slots) {
      const entry = updateEntry(slot)
      if (entry) agents[agentId] = entry
    }
    this.deps.rememberUpdates({ version: 1, agents })
  }

  private emitProcesses(): void {
    this.deps.processes(this.processes())
  }

  processes(): AgentProcess[] {
    const running = [
      ...[...this.slots.values()].map((slot) => [slot.launched, slot] as const),
      ...this.givenUp,
    ]
    return running.flatMap(([launched, { def }]) =>
      launched?.pid != null
        ? [{ agentId: def.id, pid: launched.pid, startedAt: launched.startedAt }]
        : [],
    )
  }
}

// A stop waits this long at most for a hidden session's removal, well under the 6 s main gives
// the host to stop on quit; removing takes milliseconds unless the agent hangs.
const REMOVAL_WAIT_MS = 1_000

/** Waits for `promise`, which never rejects, for at most `ms`. */
function settledWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  return Promise.race([
    promise,
    new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
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
