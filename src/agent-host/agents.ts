// Agent supervision: detection, lazy start, one process per agent, idle stop, crash counting,
// sign-in state and the AgentStatus every port sees. A harness's detection, installs and updates
// are shared by its agents: its default agent and those added with folders of their own.

import { mkdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentAccount,
  AgentAuthMethod,
  AgentDetails,
  AgentInstallMethod,
  AgentState,
  AgentStatus,
  AgentTask,
  AgentUpdate,
  McpStatus,
  PlanLimit,
} from '@shared/agent-host'
import type { AgentProcess } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { AddedAgent, HostSettings } from '@shared/settings'
import { harnessOf, type AgentId, type ConfigOption, type HarnessId } from '@shared/thread'
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
  mcpLocation,
  readAgentDetails,
  readCliVersion,
} from './agent-details'
import {
  spawnAgent,
  type AgentRun,
  type ExitInfo,
  type SpawnedAgent,
  type StopTimings,
} from './agent-process'
import type { AgentTrees } from './agent-trees'
import { decideUpdate, fetchLatest, type LatestOptions } from './agent-updates'
import {
  installArchive,
  type ArchiveInstallOptions,
  type InstalledArchive,
} from './archive-install'
import { checkApiKey, clearClaudeKey, writeClaudeKey, type ApiKeyInput } from './api-key'
import {
  installedFolder,
  installMethodOf,
  installPlans,
  updatePlan,
  type InstallPlan,
} from './binary-install'
import {
  detectAgent,
  displayCommand,
  type AgentDefinition,
  type CommandWords,
  type DetectContext,
  type Detection,
  type LaunchSpec,
} from './catalog'
import {
  AgentRequestError,
  type AgentConnection,
  type AgentInit,
  type AuthMethodInfo,
  type ConnectionHooks,
} from './connection'
import type { Diagnostics } from './diagnostics'
import type { AgentDriver, AgentTransport } from './driver'
import { driverOf, type DriverOverrides } from './drivers'
import { HostError, invalidParams } from './errors'
import { getEnv, isExecutableFile, type Env } from './find-command'
import { HostedRun, type HostedRunHooks } from './hosted-run'
import { t } from './i18n'
import { CliVersions, type CliProbe, type CliVersion } from './installed-cli'
import { claudeJsonPath, readPlanTier } from './plan-tier'
import { QUIT_REASON, type ToolOptions } from './process-tree'
import { formatCommand } from './quote'
import { hasContextReport, limitsReport, runReport, type LimitsReport } from './reports'
import { TextRing } from './ring'
import type { EnvironmentService } from './shell-env'
import type { AgentsFile, AgentUpdatesFile, RememberedInit } from './storage'
import { compareVersions } from './versions'

/** The process a process driver speaks over. */
export interface LaunchedAgent extends AgentRun {
  readonly transport: AgentTransport
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
  /** Whether Kettu's MCP server is on for this process, from the settings as it started. */
  readonly kettu: boolean
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

export interface AgentManagerDeps extends DriverOverrides {
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
  /** The session router a per-session agent launches through; null without one. */
  sessionRouterPath?: string | null
  detect?(def: AgentDefinition, ctx: DetectContext): Promise<Detection>
  install?(options: InstallOptions): Promise<InstalledAdapter>
  /** Downloads and extracts a binary agent's release archive. */
  installArchive?(options: ArchiveInstallOptions): Promise<InstalledArchive>
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
  /** An added agent was removed from the settings, and its slot with it. */
  removed?(agentId: AgentId): void
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

/** What a harness's agents share: its program and installs, and the updates found for them. */
class Harness {
  detection: Detection | null = null
  /** An install on its own, from a reinstall; installs before a start run inside `starting`. */
  installing: Promise<unknown> | null = null
  installAbort: AbortController | null = null
  /** The package install a start runs, which a start of another agent of the harness waits for. */
  packageInstall: Promise<unknown> | null = null
  /** Says the agent runs an older version because the pinned one could not be installed. */
  adapterNote: string | null = null
  /** The install whose older siblings were last deleted, once it first initialized. */
  cleanedDir: string | null = null
  /** What the last update check found, and when it finished. */
  latest: AgentUpdate | null = null
  /** The newest version of the user's own CLI on npm, from the same check. */
  cliLatest: string | null = null
  checkedAt: number | null = null
  /** The update whose notice the user dismissed in the sidebar, until a newer one is found. */
  skipped: AgentUpdate | null = null
  /** The version of the user's own CLI whose notice the user dismissed. */
  cliSkipped: string | null = null
  /** When a check last ran for this harness, found or failed; the daily check waits from it. */
  attemptedAt: number | null = null
  rememberedUpdate = 'null'
  /** The CLI version of the install a start runs, read at detection. */
  installedCli: string | null = null
  /** How the user's CLI was installed, told by where it lives. */
  cliMethod: AgentInstallMethod['id'] | null = null
  /** A binary agent's version, from its own `--version`, until it starts and reports its own. */
  binaryVersion: string | null = null
  /** The `requires` program detection found, and the version it printed. */
  requiresProgram: string | null = null
  requiresVersion: string | null = null
  /** The program `binaryVersion` was read from, so an answer for another one is dropped. */
  binaryProgram: string | null = null
  /** The `--version` failure already logged, so a repeated detection logs it once. */
  binaryVersionFailure: string | null = null
  /** The program's install routes, found at detection. */
  installPlans: InstallPlan[] = []
  /** An install or update the user asked for, which runs beside the agents' own lifecycle. */
  task: Omit<AgentTask, 'progress'> | null = null
  taskRun: Promise<void> | null = null
  taskAbort: AbortController | null = null
  taskOutput = new TextRing(8 * 1024)

  constructor(readonly def: AgentDefinition) {}
}

/** One agent: its process, sign-in, account and limits, on its harness's shared state. */
class Slot {
  state: AgentState = 'available'
  detail: string | null = null
  init: AgentInit | null = null
  runtime: AgentRuntime | null = null
  launched: AgentRun | null = null
  starting: Promise<AgentRuntime> | null = null
  stopping: Promise<void> | null = null
  /** What the running launch ran, which is the command shown while it runs. */
  launchSpec: LaunchSpec | null = null
  /** The configuration folder the running launch got, for an agent whose folder can be chosen. */
  launchConfig: RunningConfig | null = null
  intentionalStop = false
  failures: number[] = []
  signIn: AgentStatus['signIn'] = 'unknown'
  account: AgentAccount | null = null
  limits = new Map<string, PlanLimit>()
  /** Kettu handed the harness an API key for this agent, which it never reads back. */
  apiKey = false
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

  constructor(
    readonly id: AgentId,
    readonly h: Harness,
    /** An added agent's name and folder; null for the harness's default agent. */
    public added: AddedAgent | null,
  ) {}

  get def(): AgentDefinition {
    return this.h.def
  }

  get name(): string {
    return this.added?.name ?? this.h.def.name
  }
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
  return account || limits.length > 0 || init || slot.apiKey
    ? { account, limits, ...(init ? { init } : {}), ...(slot.apiKey ? { apiKey: true } : {}) }
    : null
}

/**
 * An earlier run's capabilities, until the agent initializes again, while the adapter a start
 * would run is the version that reported them.
 */
function rememberedCapabilities(slot: Slot): RememberedInit['capabilities'] | undefined {
  const detection = slot.h.detection
  const available = detection?.state === 'available' ? detection : null
  const adapter = available?.adapter ?? null
  // A harness that runs the user's CLI itself reports that CLI's version.
  const version = adapter
    ? (adapter.current ?? adapter.fallback)?.version
    : (available?.cli?.version ?? undefined)
  return version !== undefined && slot.initRecord?.version === version
    ? slot.initRecord.capabilities
    : undefined
}

function rememberedJson(slot: Slot): string {
  return JSON.stringify(rememberedEntry(slot))
}

function updateJson(h: Harness): string {
  return JSON.stringify(updateEntry(h))
}

function updateEntry(h: Harness): AgentUpdatesFile['agents'][AgentId] {
  if (h.attemptedAt === null) return undefined
  return {
    checkedAt: h.checkedAt,
    attemptedAt: h.attemptedAt,
    latest: h.latest,
    ...(h.cliLatest ? { cli: h.cliLatest } : {}),
    ...(h.skipped ? { skipped: h.skipped } : {}),
    ...(h.cliSkipped ? { skippedCli: h.cliSkipped } : {}),
  }
}

/** Whether two updates name the same adapter and CLI versions. */
function sameUpdate(a: AgentUpdate | null, b: AgentUpdate | null): boolean {
  return !!a && !!b && a.adapterVersion === b.adapterVersion && a.cliVersion === b.cliVersion
}

export class AgentManager {
  private readonly harnesses = new Map<HarnessId, Harness>()
  private readonly slots = new Map<AgentId, Slot>()
  /** Processes their stop did not end, kept listed and reaped at quit until they exit. */
  private readonly givenUp = new Map<AgentRun, Slot>()
  private readonly timings: AgentTimings
  private detected: Promise<void> | null = null
  private lastAuthCommands = '[]'
  private updateCheck: Promise<UpdateCheck> | null = null
  private updateCheckAll = false
  private updateAbort: AbortController | null = null
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly cliVersions: CliVersions
  /** The update command for each harness's user program, and what it was worked out for. */
  private readonly cliCommands = new Map<Harness, string>()
  private readonly cliCommandKeys = new Map<Harness, string>()
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
    for (const def of deps.catalog) {
      const h = new Harness(def)
      this.harnesses.set(def.id, h)
      this.slots.set(def.id, new Slot(def.id, h, null))
    }
    this.syncAgents(deps.settings().addedAgents)
  }

  has(agentId: AgentId): boolean {
    return this.slots.has(agentId)
  }

  /** The agent's name; a removed agent's sessions name its harness. */
  name(agentId: AgentId): string {
    return (
      this.slots.get(agentId)?.name ?? this.harnesses.get(harnessOf(agentId))?.def.name ?? agentId
    )
  }

  /** The agents of a harness, its default agent first. */
  private agentsOf(h: Harness): Slot[] {
    return [...this.slots.values()].filter((slot) => slot.h === h)
  }

  /**
   * Makes a slot for each added agent and drops those removed, stopping their processes. Returns
   * the ids removed, whose sessions the host closes.
   */
  private syncAgents(added: readonly AddedAgent[]): AgentId[] {
    const removed: AgentId[] = []
    for (const slot of [...this.slots.values()]) {
      if (!slot.added) continue
      const now = added.find((agent) => agent.id === slot.id)
      if (now) {
        slot.added = now
        continue
      }
      this.slots.delete(slot.id)
      removed.push(slot.id)
      void this.stopProcess(slot).catch(() => {})
    }
    for (const agent of added) {
      if (this.slots.has(agent.id)) continue
      const h = this.harnesses.get(harnessOf(agent.id))
      // An agent of a harness this build does not have stays in the settings, unlisted.
      if (!h?.def.configVariable) continue
      const slot = new Slot(agent.id, h, agent)
      if (h.detection) {
        slot.state = h.detection.state
        slot.detail = h.detection.state === 'available' ? null : h.detection.detail
      }
      this.slots.set(agent.id, slot)
    }
    return removed
  }

  mcpServersByName(agentId: AgentId): boolean {
    return this.slots.get(agentId)?.def.mcpServersByName ?? false
  }

  private slot(agentId: AgentId): Slot {
    const slot = this.slots.get(agentId)
    if (!slot) throw invalidParams(`Unknown agent ${agentId}`)
    return slot
  }

  /** The harness's default agent, whose folder detection, installs and updates run with. */
  private home(h: Harness): Slot {
    return this.slot(h.def.id)
  }

  // Detection.

  /** The first detection pass, after the environment resolves; agents.list waits for it. */
  detectAll(): Promise<void> {
    this.detected ??= (async () => {
      await this.deps.env.ready()
      await Promise.all([...this.harnesses.values()].map((h) => this.detect(h)))
    })()
    return this.detected
  }

  private async detect(h: Harness): Promise<void> {
    const platform = this.deps.platform
    const harnessSettings = this.deps.settings().agents[h.def.id]
    const env = this.deps.env.agentEnv(h.def.id)
    const node = this.deps.env.nodeProbe()
    const isExecutable = (file: string): Promise<boolean> => isExecutableFile(file, platform)
    const detection = await (this.deps.detect ?? detectAgent)(h.def, {
      platform,
      env,
      electronPath: this.deps.electronPath,
      binaryOverride: harnessSettings?.binaryPath ?? null,
      node,
      adaptersDir: this.deps.adaptersDir,
      sessionRouterPath: this.deps.sessionRouterPath ?? null,
      isExecutable,
      probeCli: (program, cliEnv) => this.askVersion(program, cliEnv),
    })
    const adapter = detection.state === 'available' ? detection.adapter : null
    const running = adapter?.current ?? adapter?.fallback
    const log = (level: 'info' | 'warn' | 'error', message: string): void =>
      this.deps.diagnostics.log(level, message)
    const [installedCli, plans, cliMethod] = await Promise.all([
      running ? readCliVersion(h.def.id, running.dir, log) : null,
      h.def.installs
        ? installPlans(h.def.installs, {
            platform,
            arch: process.arch,
            env,
            npm: node.npmPath,
            root: this.deps.adaptersDir,
            agentId: h.def.id,
            isExecutable,
          })
        : [],
      this.cliMethod(h, detection),
    ])
    h.detection = detection
    h.installedCli = installedCli
    h.installPlans = plans
    h.cliMethod = cliMethod
    h.requiresProgram =
      detection.state === 'available' ? (detection.requires?.program ?? null) : null
    h.requiresVersion =
      detection.state === 'available' ? (detection.requires?.version ?? null) : null
    // A binary agent's own version is asked in the background, so detection never waits for it.
    const program =
      h.def.launch.kind === 'binary' && detection.state === 'available'
        ? (detection.spec?.command ?? null)
        : null
    if (program !== h.binaryProgram) {
      h.binaryProgram = program
      h.binaryVersion = null
      h.binaryVersionFailure = null
    }
    for (const slot of this.agentsOf(h)) {
      // A running, installing, failed or recovering agent keeps its lifecycle state.
      const idle = !slot.launched && !slot.starting && !h.installing && slot.state !== 'failed'
      if (idle) {
        slot.state = detection.state
        slot.detail = detection.state === 'available' ? null : detection.detail
      }
    }
    this.emit(this.home(h))
    if (program) void this.askBinaryVersion(h, program, env)
  }

  /** How the user's own CLI, or a binary harness's program, was installed. */
  private async cliMethod(
    h: Harness,
    detection: Detection,
  ): Promise<AgentInstallMethod['id'] | null> {
    const installs = h.def.installs
    const found =
      detection.cli?.path ??
      (h.def.launch.kind === 'binary' && detection.state === 'available'
        ? detection.spec?.command
        : undefined)
    if (!installs || !found) return null
    const real = await realpath(found).catch(() => found)
    return installMethodOf(installs, real, { platform: this.deps.platform, home: os.homedir() })
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
  private async askBinaryVersion(h: Harness, program: string, env: Env): Promise<void> {
    let answer: CliVersion
    try {
      answer = await this.askVersion(program, env)
    } catch (error) {
      answer = { error: (error as Error).message }
    }
    // A detection that moved on to another program has asked its own version.
    if (h.binaryProgram !== program) return
    if ('error' in answer) {
      h.binaryVersion = null
      // The same failure is logged once, however often detection asks again.
      if (h.binaryVersionFailure !== answer.error) {
        h.binaryVersionFailure = answer.error
        this.deps.diagnostics.log(
          'warn',
          `${h.def.name}: could not read its version: ${answer.error}`,
        )
      }
    } else {
      h.binaryVersion = answer.version
      h.binaryVersionFailure = null
    }
    this.emit(this.home(h))
  }

  async list(): Promise<AgentStatus[]> {
    await this.detectAll()
    return this.statuses()
  }

  async check(agentId?: AgentId): Promise<AgentStatus[]> {
    await this.detectAll()
    const harnesses = agentId ? [this.slot(agentId).h] : [...this.harnesses.values()]
    await Promise.all(harnesses.map((h) => this.detect(h)))
    return this.statuses()
  }

  async reloadEnvironment(): Promise<AgentStatus[]> {
    await this.deps.env.reload()
    this.cliVersions.clear()
    await Promise.all([...this.harnesses.values()].map((h) => this.detect(h)))
    return this.statuses()
  }

  /**
   * Agents were added, renamed or removed, a program was picked, or a default agent hidden: sync
   * the slots and detect the affected harnesses again. The environment already carries each
   * agent's folder. Returns the agents removed.
   */
  async settingsChanged(previous: HostSettings, next: HostSettings): Promise<AgentId[]> {
    const removed = this.syncAgents(next.addedAgents)
    for (const agentId of removed) this.deps.removed?.(agentId)
    // A default agent's folder from before agents could be added can only be cleared, which
    // gives its account, limits and prepared session back to the harness's default folder.
    for (const h of this.harnesses.values()) {
      if (!h.def.configVariable) continue
      if (previous.agents[h.def.id]?.configDir === next.agents[h.def.id]?.configDir) continue
      const slot = this.home(h)
      slot.account = null
      slot.limits.clear()
      this.hooks.configChanged(slot.id)
    }
    // Detecting again rewrites each idle agent's guidance in the new language.
    const changed = [...this.harnesses.values()].filter(
      (h) =>
        previous.locale !== next.locale ||
        previous.agents[h.def.id]?.binaryPath !== next.agents[h.def.id]?.binaryPath ||
        previous.agents[h.def.id]?.configDir !== next.agents[h.def.id]?.configDir,
    )
    await Promise.all(changed.map((h) => this.detect(h)))
    // A rename, a hidden default agent or a switch for Kettu's server shows in the status; the
    // switch changes what a start gets, and waits for the next one.
    for (const slot of this.slots.values()) this.emit(slot)
    return removed
  }

  // Lifecycle.

  runtime(agentId: AgentId): AgentRuntime | null {
    const slot = this.slots.get(agentId)
    return slot && !slot.stopping ? slot.runtime : null
  }

  /** Starts the agent if needed; rejects with `agent_unavailable` when it cannot run. */
  async ensureReady(agentId: AgentId): Promise<AgentRuntime> {
    // A session keeps its agent, which may have been removed since.
    if (!this.slots.has(agentId)) throw new HostError('agent_unavailable', t('agent.removed'))
    const slot = this.slot(agentId)
    const { h } = slot
    await this.detectAll()
    if (slot.stopping) await slot.stopping
    if (h.installing) await h.installing.catch(() => {})
    if (slot.runtime) return slot.runtime
    if (slot.starting) return slot.starting
    if (slot.state === 'failed') {
      throw new HostError(
        'agent_unavailable',
        slot.detail ?? t('agent.failedToStart', { agent: slot.name }),
        { agentId, state: 'failed' },
      )
    }
    if (h.detection?.state !== 'available') await this.detect(h)
    const detection = h.detection
    if (detection?.state !== 'available') {
      throw new HostError(
        'agent_unavailable',
        detection?.detail ?? t('agent.notAvailable', { agent: slot.name }),
        {
          agentId,
          state: detection?.state ?? 'not-installed',
        },
      )
    }
    return this.start(slot, detection.spec)
  }

  /** Launches `spec`, or installs the pinned adapter first when it is null. */
  private async start(slot: Slot, spec: LaunchSpec | null): Promise<AgentRuntime> {
    const run = (async () => this.launch(slot, spec ?? (await this.installPackage(slot))))()
    slot.starting = run
    try {
      const runtime = await run
      this.cleanUpVersions(slot)
      this.sessionsChanged(slot.id)
      return runtime
    } catch (error) {
      const message = (error as Error).message
      // A start the quit stopped did not fail either.
      if (error instanceof InstallCancelled || this.stopped) {
        slot.state = slot.h.detection?.state ?? 'available'
        slot.detail = null
        this.emit(slot)
        throw new HostError('agent_unavailable', message, {
          agentId: slot.id,
          state: slot.state,
        })
      }
      // The SDK it just installed needs a newer CLI than the user's: that is not a failure.
      const detection = slot.h.detection
      if (detection && detection.state !== 'available') {
        slot.state = detection.state
        slot.detail = detection.detail
        this.emit(slot)
        throw new HostError('agent_unavailable', detection.detail, {
          agentId: slot.id,
          state: slot.state,
        })
      }
      this.recordFailure(slot)
      slot.state = 'failed'
      slot.detail = message
      this.emit(slot)
      throw new HostError('agent_unavailable', slot.detail ?? message, {
        agentId: slot.id,
        state: slot.state,
      })
    } finally {
      slot.starting = null
    }
  }

  private async launch(slot: Slot, spec: LaunchSpec): Promise<AgentRuntime> {
    const { diagnostics } = this.deps
    const agentId = slot.id
    if (this.stopped) throw new Error(`${slot.name} was not started: the host is stopping.`)
    slot.state = 'starting'
    slot.detail = null
    slot.progress.clear()
    slot.intentionalStop = false
    slot.launchSpec = spec
    const env = this.deps.env.agentEnv(agentId)
    slot.launchConfig = this.configIn(slot, env)
    this.emit(slot)
    diagnostics.event(agentId, 'start', formatCommand(spec.display, this.deps.platform))
    const { launched, connection } = this.connect(slot, spec, env)
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
                  agent: slot.name,
                  seconds: String(timeoutMs / 1000),
                }),
              ),
            )
          }, timeoutMs)
        }),
        launched.exited.then((info): never => {
          const tail = slot.progress.lastLines(3).join(' ')
          const exit = exitText(slot.name, info)
          throw new Error(`${t('agent.exitedBeforeReady', { exit })}${tail ? ` ${tail}` : ''}`)
        }),
      ])
      const runtime: AgentRuntime = {
        agentId,
        connection,
        init,
        kettu: this.kettuOn(agentId),
      }
      slot.init = init
      // The state file keeps booleans; how an agent titles its sessions comes with `initialize`.
      const remembered: Partial<AgentInit['capabilities']> = { ...init.capabilities }
      delete remembered.ownTitles
      slot.initRecord = init.version ? { version: init.version, capabilities: remembered } : null
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
        ? new Error(`${slot.name} failed to initialize: ${error.message}`)
        : error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private driver(slot: Slot): AgentDriver {
    return driverOf(slot.def, this.deps)
  }

  /**
   * Starts the agent through its protocol's driver: over the stdio of the process the launcher
   * spawns, or as a run in the host whose processes are recorded and stopped as the agent's own.
   */
  private connect(
    slot: Slot,
    spec: LaunchSpec,
    env: Env,
  ): { launched: AgentRun; connection: AgentConnection } {
    const driver = this.driver(slot)
    const context = { def: slot.def, hooks: this.connectionHooks(slot), spec, env }
    if (driver.kind === 'process') {
      const launched = this.deps.launcher.launch(slot.def, spec, env, {
        stderr: (text) => this.onStderr(slot, text),
        event: (event, detail) => this.deps.diagnostics.event(slot.id, event, detail),
      })
      slot.launched = launched
      if (launched.pid !== null) {
        this.deps.trees?.launched({ pid: launched.pid, startedAt: launched.startedAt })
      }
      this.emitProcesses()
      return { launched, connection: driver.connect(launched.transport, context) }
    }
    const run = new HostedRun(this.deps.platform, this.hostedHooks(slot))
    slot.launched = run
    let connection: AgentConnection
    try {
      connection = driver.connect({ ...context, spec, env, spawn: run.spawn })
    } catch (error) {
      slot.launched = null
      throw error
    }
    run.attach(connection)
    return { launched: run, connection }
  }

  /** How a run in the host records and stops the processes it spawns, as the agent's own. */
  private hostedHooks(slot: Slot): HostedRunHooks {
    const { diagnostics } = this.deps
    const agentId = slot.id
    return {
      stderr: (text) => this.onStderr(slot, text),
      event: (event, detail) => diagnostics.event(agentId, event, detail),
      spawned: (child) => {
        if (child.pid !== null) {
          this.deps.trees?.launched({ pid: child.pid, startedAt: child.startedAt })
        }
        this.emitProcesses()
      },
      exited: (child) => {
        void this.reapTree(slot, child)
        this.givenUp.delete(child)
        this.emitProcesses()
      },
      stop: (child, tools) => this.stopChild(slot, child, tools),
    }
  }

  /** Stops a process a run in the host spawned as `stopProcess` stops an agent's own. */
  private async stopChild(slot: Slot, child: SpawnedAgent, tools: ToolOptions): Promise<void> {
    await this.noteTree(child)
    const info = await child.stop(tools)
    if (!child.hasExited) {
      const { diagnostics } = this.deps
      diagnostics.event(slot.id, 'stop failed', describeExit(info))
      diagnostics.log('warn', `A process ${slot.name} ran did not stop: ${describeExit(info)}`)
      this.givenUp.set(child, slot)
      this.emitProcesses()
    }
    await this.reapTree(slot, child)
  }

  /** The agent's process, or the processes its run in the host spawned. */
  private processesOf(slot: Slot): AgentRun[] {
    const { launched } = slot
    if (!launched) return []
    return launched instanceof HostedRun ? launched.children : [launched]
  }

  private onExit(
    slot: Slot,
    launched: AgentRun,
    connection: AgentConnection,
    info: ExitInfo,
  ): void {
    const agentId = slot.id
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
        slot.state = slot.h.detection?.state ?? 'available'
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
        detail: t('agent.exited', { exit: exitText(slot.name, info) }),
        count: this.timings.maxFailures,
      })
    } else {
      slot.state = slot.h.detection?.state ?? 'available'
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
   * instead and says so in the status. Another agent of the harness that starts meanwhile waits
   * for this install rather than run its own.
   */
  private async installPackage(
    slot: Slot,
    request: { version?: string; alongside?: boolean; fallback?: boolean } = {},
  ): Promise<LaunchSpec> {
    const { h } = slot
    if (h.packageInstall && request.version === undefined) {
      await h.packageInstall.catch(() => {})
      const spec = h.detection?.state === 'available' ? h.detection.spec : null
      if (spec) return spec
    }
    const run = this.installPackageNow(slot, request)
    h.packageInstall = run
    try {
      return await run
    } finally {
      if (h.packageInstall === run) h.packageInstall = null
    }
  }

  private async installPackageNow(
    slot: Slot,
    request: { version?: string; alongside?: boolean; fallback?: boolean },
  ): Promise<LaunchSpec> {
    const { h } = slot
    if (this.stopped) {
      throw new InstallCancelled(`${h.def.name} was not installed: the host is stopping.`)
    }
    const detection = h.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    if (!detection || detection.state !== 'available' || !adapter) {
      throw new Error(`${h.def.name} has no adapter to install.`)
    }
    const { diagnostics, platform } = this.deps
    const harnessId = h.def.id
    const version = request.version ?? adapter.version
    // The SDK never brings the CLI of its own: only the user's runs.
    const withoutCli = !!h.def.cli
    slot.state = 'installing'
    slot.detail = null
    slot.progress.clear()
    this.emit(slot)
    const abort = new AbortController()
    h.installAbort = abort
    const started = Date.now()
    diagnostics.event(slot.id, 'install', `${adapter.package}@${version}`)
    try {
      if (!adapter.npm) throw new Error('npm was not found on PATH.')
      await (this.deps.install ?? installAdapter)({
        root: this.deps.adaptersDir,
        agentId: harnessId,
        package: adapter.package,
        version,
        npm: adapter.npm,
        nodeVersion: adapter.nodeVersion,
        platform,
        env: this.deps.env.agentEnv(harnessId),
        timeoutMs: this.timings.installMs,
        signal: abort.signal,
        onOutput: (text) => this.onProgress(slot, text),
        ...(request.alongside ? { alongside: true } : {}),
        ...(withoutCli ? { withoutCli: true } : {}),
      })
      diagnostics.event(slot.id, 'installed', `${version} in ${Date.now() - started} ms`)
      h.adapterNote = null
      await this.detect(h)
      const detected = h.detection?.state === 'available' ? h.detection : null
      const spec = detected?.spec ?? null
      // The SDK just installed may need a newer CLI than the user's, which detection now says.
      if (!spec) {
        throw new Error(
          h.detection?.state === 'available'
            ? `${adapter.package} ${version} is incomplete on disk.`
            : h.detection?.detail,
        )
      }
      return spec
    } catch (error) {
      const message = (error as Error).message
      diagnostics.event(slot.id, 'install failed', message)
      const text = t('agent.installFailed', { agent: h.def.name, message })
      if (abort.signal.aborted) throw new InstallCancelled(text, { cause: error })
      if (adapter.fallback && request.fallback !== false) {
        h.adapterNote = t('agent.runningFallback', {
          fallback: adapter.fallback.version,
          version,
          message,
        })
        return adapter.fallback.spec
      }
      throw new Error(text, { cause: error })
    } finally {
      h.installAbort = null
    }
  }

  /**
   * Once the install a start picks runs, the older installs go. A newer one, such as an update
   * that finished meanwhile, stays, and so does the install this process runs from. While a
   * process its stop gave up still runs, possibly from an older install, nothing goes until the
   * last one exits.
   */
  private cleanUpVersions(slot: Slot): void {
    const { h } = slot
    const detection = h.detection
    const { launch } = h.def
    if (detection?.state !== 'available' || launch.kind !== 'package') return
    const current = detection.adapter?.current
    if (!current || !detection.spec || slot.launchSpec !== detection.spec) return
    if (h.cleanedDir === current.dir) return
    if (this.agentsOf(h).some((agent) => this.givenUpRuns(agent))) return
    h.cleanedDir = current.dir
    const harnessId = h.def.id
    removeOlderInstalls(this.deps.adaptersDir, harnessId, launch.package, current).then(
      (removed) => {
        if (removed.length > 0) {
          this.deps.diagnostics.event(slot.id, 'removed', removed.join(', '))
        }
      },
      (error: unknown) =>
        this.deps.diagnostics.log(
          'warn',
          `${h.def.name}: could not remove older versions: ${(error as Error).message}`,
        ),
    )
  }

  /** Refuses a second install or update while one runs. */
  private assertNoInstall(h: Harness): void {
    const installing = this.agentsOf(h).some((slot) => slot.state === 'installing')
    if (h.task?.state === 'running' || h.installing || installing) {
      throw new HostError('busy', t('agent.busyTask', { agent: h.def.name }))
    }
  }

  /** The sessions open with any of the harness's agents. */
  private liveSessionsOf(h: Harness): number {
    return this.agentsOf(h).reduce((sum, slot) => sum + this.hooks.liveSessions(slot.id), 0)
  }

  /**
   * Deletes the installed adapter and installs it again, while no session uses any of the
   * harness's agents. The harness is claimed before the first await, so a start that comes
   * meanwhile waits for the result.
   */
  async reinstall(agentId: AgentId): Promise<void> {
    const { h } = this.slot(agentId)
    const home = this.home(h)
    const agents = this.agentsOf(h)
    const { launch } = h.def
    if (launch.kind !== 'package') {
      throw invalidParams(`${h.def.name} is not installed by Kettu`)
    }
    if (h.installing || agents.some((slot) => slot.starting)) {
      throw new HostError('busy', t('agent.busyInstalling', { agent: h.def.name }))
    }
    if (h.task?.state === 'running') {
      throw new HostError('busy', t('agent.busyTask', { agent: h.def.name }))
    }
    if (this.liveSessionsOf(h) > 0) {
      throw new HostError('busy', t('agent.closeSessionsFirst', { agent: h.def.name }))
    }
    const stillRunning = (): HostError =>
      new HostError('busy', t('agent.stillRunning', { agent: h.def.name }))
    const givenUp = (): boolean => agents.some((slot) => this.givenUpRuns(slot))
    if (givenUp()) throw stillRunning()
    const run = (async () => {
      await this.detectAll()
      await Promise.all(agents.map((slot) => this.stopProcess(slot)))
      // A process its stop gave up may still run from the install, which must not go under it.
      if (givenUp()) throw stillRunning()
      // The install a start runs goes, and the same version comes back.
      const detected = h.detection?.state === 'available' ? h.detection.adapter : null
      const removed = detected?.current ?? null
      if (removed) await removeInstall(removed.dir)
      h.cleanedDir = null
      for (const slot of agents) {
        slot.failures = []
        slot.state = 'available'
        slot.detail = null
      }
      await this.detect(h)
      if (h.detection?.state !== 'available') {
        throw new HostError(
          'agent_unavailable',
          h.detection?.detail ?? t('agent.cannotInstall', { agent: h.def.name }),
        )
      }
      try {
        await this.installPackage(home, {
          version: removed?.version ?? launch.version,
          alongside: true,
        })
        home.state = 'available'
      } catch (error) {
        if (error instanceof InstallCancelled) {
          home.state = h.detection?.state ?? 'available'
          home.detail = null
          return
        }
        home.state = 'failed'
        home.detail = (error as Error).message
        throw new HostError('agent_unavailable', home.detail, { agentId, state: 'failed' })
      } finally {
        this.emit(home)
      }
    })()
    h.installing = run
    try {
      await run
    } finally {
      h.installing = null
    }
  }

  // Updates and installs the user asks for.

  /**
   * The SDK update to offer: what the last check found, against the install a start runs. One that
   * runs an install below the pin, because the pinned one could not be installed, is offered the
   * pin at least.
   */
  private updateOf(h: Harness): AgentUpdate | null {
    const detection = h.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    const running = adapter?.current ?? adapter?.fallback
    if (!adapter || !running) return null
    let offered = decideUpdate(h.latest, {
      version: running.version,
      cliVersion: h.installedCli,
    })
    // Only a newer adapter is an update, and it comes without a CLI. One that needs a newer CLI
    // than the user's waits until theirs is updated, which updating the CLI does at once.
    if (offered && h.def.cli) {
      const mine = detection?.state === 'available' ? detection.cli : undefined
      const outgrown =
        h.def.cli.pinsVersion &&
        !!offered.cliVersion &&
        !!mine?.version &&
        !mine.variable &&
        compareVersions(mine.version, offered.cliVersion) < 0
      offered =
        !outgrown && compareVersions(offered.adapterVersion, running.version) > 0
          ? { adapterVersion: offered.adapterVersion, cliVersion: null }
          : null
    }
    if (adapter.current) return offered
    return offered && compareVersions(offered.adapterVersion, adapter.version) >= 0
      ? offered
      : { adapterVersion: adapter.version, cliVersion: null }
  }

  /** The user's own program, as detection found it: the SDK's CLI, or a binary harness's program. */
  private userProgram(h: Harness): { path: string; version: string | null } | null {
    const detection = h.detection
    if (detection?.cli) return { path: detection.cli.path, version: detection.cli.version }
    if (h.def.launch.kind !== 'binary' || detection?.state !== 'available' || !detection.spec) {
      return null
    }
    return { path: detection.spec.command, version: h.binaryVersion }
  }

  /**
   * A newer version of the user's own program than the one it runs: from npm, or, for one too old
   * to run, at least the oldest that runs, which its own update brings before any check.
   */
  private cliUpdateVersion(h: Harness): string | null {
    const mine = this.userProgram(h)
    const problem = h.detection?.cli?.problem
    if (problem?.kind === 'too-old') return h.cliLatest ?? problem.minimum
    if (!h.cliLatest || !mine?.version) return null
    return compareVersions(h.cliLatest, mine.version) > 0 ? h.cliLatest : null
  }

  /** What an earlier run's update check found, so an update shows without the network. */
  restoreUpdates(file: AgentUpdatesFile): void {
    for (const [harnessId, entry] of Object.entries(file.agents) as [
      AgentId,
      AgentUpdatesFile['agents'][AgentId],
    ][]) {
      const h = this.harnesses.get(harnessId as HarnessId)
      if (!h || !entry || !this.checksUpdates(h)) continue
      h.latest = entry.latest
      h.cliLatest = entry.cli ?? null
      h.checkedAt = entry.checkedAt
      h.attemptedAt = entry.attemptedAt
      h.skipped = entry.skipped ?? null
      h.cliSkipped = entry.skippedCli ?? null
      h.rememberedUpdate = updateJson(h)
      this.emit(this.home(h))
    }
  }

  /** Kettu's own package for it, or the user's program, which npm publishes, is checked. */
  private checksUpdates(h: Harness): boolean {
    return h.def.launch.kind === 'package' || !!h.def.installs?.npm
  }

  /**
   * Checks each harness once its last check, found or failed, is a day old, but no sooner than a
   * minute after start. Called once the first detection is done, and again after each check.
   */
  scheduleUpdateChecks(): void {
    if (this.updateTimer || this.stopped) return
    const harnesses = this.checkable()
    if (harnesses.length === 0) return
    const next = Math.min(...harnesses.map((h) => this.checkDue(h)))
    const delayMs = Math.max(this.timings.updateDelayMs, next - Date.now())
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null
      void this.runUpdateCheck(false).then(() => this.scheduleUpdateChecks())
    }, delayMs)
    this.updateTimer.unref?.()
  }

  /**
   * The harnesses a check can ask npm about: those with a package of Kettu's whose npm was found,
   * and those whose user's program is installed, whose versions npm publishes too.
   */
  private checkable(): Harness[] {
    const npm = this.deps.env.nodeProbe().npmPath
    return [...this.harnesses.values()].filter((h) => {
      const detection = h.detection
      if (h.def.launch.kind === 'package') {
        return detection?.state === 'available' && !!detection.adapter?.npm
      }
      return !!npm && !!h.def.installs?.npm && !!this.userProgram(h)
    })
  }

  private checkDue(h: Harness): number {
    return (h.attemptedAt ?? 0) + this.timings.updateIntervalMs
  }

  /**
   * The user's check (`all`) asks about every harness; the daily one only about those due, so one
   * whose check keeps failing waits a day like the others. Never rejects, and a failure keeps the
   * last result. A user's check during a daily one runs after it.
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
      const harnesses = this.checkable().filter((h) => all || this.checkDue(h) <= now)
      const results = await Promise.all(harnesses.map((h) => this.checkHarness(h, abort.signal)))
      return { checked: harnesses.length, failures: results.filter((r) => r !== null) }
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

  private async checkHarness(h: Harness, signal: AbortSignal): Promise<string | null> {
    const { launch } = h.def
    const detection = h.detection
    const npm =
      (detection?.state === 'available' ? detection.adapter?.npm : null) ??
      this.deps.env.nodeProbe().npmPath
    if (!npm) return null
    const options = {
      npm,
      env: this.deps.env.agentEnv(h.def.id),
      platform: this.deps.platform,
      cwd: os.homedir(),
      timeoutMs: this.timings.updateViewMs,
      signal,
    }
    const fetch = this.deps.fetchLatest ?? fetchLatest
    const cliPackage = h.def.installs?.npm
    try {
      const [latest, cli] = await Promise.all([
        launch.kind === 'package'
          ? fetch({
              ...options,
              package: launch.package,
              ...(launch.updates ? { range: launch.updates } : {}),
              cli: CLI_VERSION_SOURCES[h.def.id] ?? null,
            })
          : null,
        cliPackage && this.userProgram(h)
          ? fetch({ ...options, package: cliPackage, cli: null })
          : null,
      ])
      if (latest) h.latest = latest
      if (cli) h.cliLatest = cli.adapterVersion
      h.checkedAt = Date.now()
      h.attemptedAt = h.checkedAt
      const found = [
        latest
          ? `${latest.adapterVersion}${latest.cliVersion ? `, CLI ${latest.cliVersion}` : ''}`
          : '',
        cli ? `${cliPackage} ${cli.adapterVersion}` : '',
      ]
      this.deps.diagnostics.event(h.def.id, 'update check', found.filter(Boolean).join('; '))
      this.emit(this.home(h))
      return null
    } catch (error) {
      const message = (error as Error).message
      this.deps.diagnostics.log('warn', `${h.def.name}: the update check failed: ${message}`)
      h.attemptedAt = Date.now()
      this.emit(this.home(h))
      return message
    }
  }

  /** The user's check: resolves with the statuses, or rejects when no harness could be checked. */
  async checkUpdates(): Promise<AgentStatus[]> {
    const { checked, failures } = await this.runUpdateCheck(true)
    if (checked === 0) throw new HostError('agent_unavailable', t('agent.update.noNpm'))
    if (failures.length === checked) {
      throw new HostError('agent_error', t('agent.update.checkFailed', { reason: failures[0] }))
    }
    return this.statuses()
  }

  /**
   * Installs the SDK's update beside the install that runs now, which keeps running; a start after
   * it runs the new one. Resolves when done or cancelled; a failure leaves the old install as it was.
   */
  async update(agentId: AgentId): Promise<void> {
    const { h } = this.slot(agentId)
    const { launch } = h.def
    if (launch.kind !== 'package') {
      throw invalidParams(`${h.def.name} is not installed by Kettu`)
    }
    await this.detectAll()
    const update = this.updateOf(h)
    if (!update) throw invalidParams(t('agent.update.none', { agent: h.def.name }))
    this.assertNoInstall(h)
    const command = this.packageUpdateCommand(h, update)
    await this.runTask(
      h,
      'update',
      command,
      (signal, onOutput) => this.installUpdate(h, update, signal, onOutput),
      (message) => t('agent.updateFailed', { agent: h.def.name, message }),
    )
  }

  private packageUpdateCommand(h: Harness, update: AgentUpdate): string {
    const { launch } = h.def
    const adapter = h.detection?.state === 'available' ? h.detection.adapter : null
    if (launch.kind !== 'package' || !adapter?.npm) return ''
    const [, ...flags] = h.def.cli ? [...NPM_INSTALL_ARGS, OMIT_CLI_ARG] : NPM_INSTALL_ARGS
    return formatCommand(
      {
        command: adapter.npm,
        args: ['install', `${launch.package}@${update.adapterVersion}`, ...flags],
      },
      this.deps.platform,
    )
  }

  /** Installs the SDK's or adapter's update beside the running install. */
  private async installUpdate(
    h: Harness,
    update: AgentUpdate,
    signal: AbortSignal,
    onOutput: (text: string) => void,
  ): Promise<void> {
    const { launch } = h.def
    const adapter = h.detection?.state === 'available' ? h.detection.adapter : null
    const npm = adapter?.npm
    if (launch.kind !== 'package' || !adapter || !npm) {
      throw new HostError(
        'agent_unavailable',
        t('detect.npmMissing', { agent: h.def.name, hint: t(h.def.install.hint) }),
      )
    }
    const { platform, diagnostics } = this.deps
    const harnessId = h.def.id
    const version = update.adapterVersion
    const started = Date.now()
    diagnostics.event(harnessId, 'update', `${launch.package}@${version}`)
    const installed = await (this.deps.install ?? installAdapter)({
      root: this.deps.adaptersDir,
      agentId: harnessId,
      package: launch.package,
      version,
      npm,
      nodeVersion: adapter.nodeVersion,
      platform,
      env: this.deps.env.agentEnv(harnessId),
      timeoutMs: this.timings.installMs,
      signal,
      onOutput,
      alongside: true,
      ...(h.def.cli ? { withoutCli: true } : {}),
    })
    diagnostics.event(harnessId, 'updated', `${installed.version} in ${Date.now() - started} ms`)
    await this.detect(h)
    h.skipped = null
    // A fresh install can take another CLI than the check foresaw; what it took is the latest.
    if (this.updateOf(h)) {
      h.latest = { adapterVersion: installed.version, cliVersion: h.installedCli }
    }
  }

  /**
   * Updates the user's own program the way it was installed: its own update command or the
   * install script again, `brew upgrade`, `winget upgrade` or `npm install -g`. For Claude Code the
   * SDK then moves to the version that matches, when one is on offer.
   */
  async updateCli(agentId: AgentId): Promise<void> {
    const { h } = this.slot(agentId)
    await this.detectAll()
    const plan = await this.cliUpdatePlan(h)
    if (!plan?.run) {
      throw invalidParams(
        plan
          ? t('agent.binaryInstall.unavailable', { command: plan.command })
          : t('agent.update.none', { agent: h.def.name }),
      )
    }
    this.assertNoInstall(h)
    const run = plan.run
    const { platform, diagnostics } = this.deps
    const timeoutMs = this.timings.installMs
    await this.runTask(
      h,
      'update',
      plan.command,
      async (signal, onOutput) => {
        diagnostics.event(h.def.id, 'update', plan.command)
        const result = await (this.deps.runProgram ?? runProgram)({
          program: run.program,
          args: run.args,
          cwd: os.homedir(),
          env: this.deps.env.agentEnv(h.def.id),
          platform,
          timeoutMs,
          signal,
          onOutput,
        })
        const name = path.basename(run.program).replace(/\.(?:cmd|exe)$/i, '')
        const failure = programFailure(name, result, timeoutMs)
        if (failure) throw new Error(failure)
        this.cliVersions.clear()
        await this.detect(h)
        h.cliSkipped = null
        const update = this.updateOf(h)
        if (update && !this.stopped) await this.installUpdate(h, update, signal, onOutput)
      },
      (message) => t('agent.updateFailed', { agent: h.def.name, message }),
      h.cliMethod,
    )
  }

  /** The update the user's program takes, the way it was installed; null when that is unknown. */
  private async cliUpdatePlan(
    h: Harness,
  ): Promise<{ command: string; run: { program: string; args: string[] } | null } | null> {
    const installs = h.def.installs
    const mine = this.userProgram(h)
    if (!installs || !mine || !h.cliMethod) return null
    const platform = this.deps.platform
    return updatePlan(installs, h.cliMethod, {
      platform,
      env: this.deps.env.agentEnv(h.def.id),
      npm: this.deps.env.nodeProbe().npmPath,
      isExecutable: (file) => isExecutableFile(file, platform),
      program: mine.path,
    })
  }

  /**
   * Skips the harness's current update in the sidebar's notice, until a newer adapter or CLI is
   * found. Installing an update clears the skip.
   */
  async skipUpdate(agentId: AgentId): Promise<void> {
    const { h } = this.slot(agentId)
    const update = this.updateOf(h)
    const cli = this.cliUpdateVersion(h)
    // The update can be gone by the time the click arrives, as when it installed meanwhile.
    if (!update && !cli) return
    if (update) h.skipped = update
    if (cli) h.cliSkipped = cli
    this.emit(this.home(h))
  }

  /**
   * Installs a harness that is missing: the user's own program by one of its routes, or a package
   * harness's pinned adapter now, without starting it. Resolves when done or cancelled.
   */
  async install(agentId: AgentId, method?: AgentInstallMethod['id']): Promise<void> {
    const { h } = this.slot(agentId)
    await this.detectAll()
    // The user's CLI the SDK runs is installed first; one found too old is updated instead.
    const cliMissing = h.detection?.state === 'not-installed' && !h.detection.cli
    if (h.def.cli && h.def.launch.kind === 'package' && cliMissing) {
      return this.installProgram(h, method)
    }
    switch (h.def.launch.kind) {
      case 'package':
        return this.installNow(h)
      case 'binary':
        return this.installProgram(h, method)
      case 'uvx':
      case 'node-script':
        throw invalidParams(`${h.def.name} is not installed by Kettu`)
    }
  }

  /** The first-use install, shared with any start that waits for it. */
  private async installNow(h: Harness): Promise<void> {
    const home = this.home(h)
    const agentId = home.id
    if (h.installing) {
      await h.installing
      return
    }
    if (!home.starting && h.detection?.state !== 'available') await this.detect(h)
    const detection = h.detection
    if (detection?.state !== 'available') {
      throw new HostError(
        'agent_unavailable',
        detection?.detail ?? t('agent.cannotInstall', { agent: h.def.name }),
        { agentId, state: detection?.state ?? 'not-installed' },
      )
    }
    if (detection.adapter?.installed) return
    // A start that installs first.
    const starting = this.agentsOf(h).find((slot) => slot.starting)?.starting
    if (starting) {
      await starting
      return
    }
    this.assertNoInstall(h)
    const run = (async () => {
      try {
        await this.installPackage(home, { fallback: false })
        home.state = 'available'
      } catch (error) {
        if (error instanceof InstallCancelled) {
          home.state = h.detection?.state ?? 'available'
          home.detail = null
          return
        }
        const message = (error as Error).message
        // An older install still runs, so the agent stays usable and only this install failed.
        if (detection.adapter?.fallback) {
          home.state = h.detection?.state ?? 'available'
          home.detail = null
          throw new HostError('agent_error', message, { agentId })
        }
        home.state = 'failed'
        home.detail = message
        throw new HostError('agent_unavailable', home.detail, { agentId, state: 'failed' })
      } finally {
        this.emit(home)
      }
    })()
    h.installing = run
    try {
      await run
    } finally {
      h.installing = null
    }
  }

  /** Installs the harness's program by one of its vendor's routes, or the registry's archive. */
  private async installProgram(
    h: Harness,
    methodId: AgentInstallMethod['id'] | undefined,
  ): Promise<void> {
    const installs = h.def.installs
    const agent = h.def.name
    if (!installs) throw invalidParams(`${agent} is not installed by Kettu`)
    if (h.detection?.state === 'available') {
      throw invalidParams(t('agent.alreadyInstalled', { agent }))
    }
    const plan = methodId
      ? h.installPlans.find((candidate) => candidate.id === methodId)
      : h.installPlans.find((candidate) => candidate.available)
    if (!plan) {
      throw invalidParams(
        methodId
          ? `${agent} has no ${methodId} install on this platform`
          : t('agent.binaryInstall.noMethod', { agent }),
      )
    }
    if (!plan.available) {
      throw invalidParams(t('agent.binaryInstall.unavailable', { command: plan.command }))
    }
    if (plan.id === 'archive') return this.installArchive(h, plan)
    const run = plan.run
    if (!run) {
      throw invalidParams(t('agent.binaryInstall.unavailable', { command: plan.command }))
    }
    this.assertNoInstall(h)
    const { platform, diagnostics } = this.deps
    const home = os.homedir()
    const timeoutMs = this.timings.installMs
    await this.runTask(
      h,
      'install',
      plan.command,
      async (signal, onOutput) => {
        diagnostics.event(h.def.id, 'install', plan.command)
        const result = await (this.deps.runProgram ?? runProgram)({
          program: run.program,
          args: run.args,
          cwd: home,
          env: this.deps.env.agentEnv(h.def.id),
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
        this.cliVersions.clear()
        await Promise.all([...this.harnesses.values()].map((other) => this.detect(other)))
        if (h.detection?.state === 'available') return
        const folder = await installedFolder(plan, installs, {
          platform,
          home,
          npmPrefix: () => this.npmPrefix(plan.tool),
        })
        const command =
          h.def.cli?.command ?? (h.def.launch.kind === 'binary' ? h.def.launch.command : agent)
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

  /** Downloads the registry's archive for the harness, then detects again so it turns available. */
  private async installArchive(h: Harness, plan: InstallPlan): Promise<void> {
    const archive = plan.archive
    if (!archive) throw invalidParams(`${h.def.name} has no archive to download`)
    this.assertNoInstall(h)
    const { platform, diagnostics } = this.deps
    const agent = h.def.name
    const timeoutMs = this.timings.installMs
    await this.runTask(
      h,
      'install',
      plan.command,
      async (signal, onOutput) => {
        diagnostics.event(h.def.id, 'install', plan.command)
        const installed = await (this.deps.installArchive ?? installArchive)({
          root: this.deps.adaptersDir,
          agentId: h.def.id,
          version: archive.version,
          url: archive.url,
          ...(archive.sha256 ? { sha256: archive.sha256 } : {}),
          cmd: archive.cmd,
          ...(archive.args ? { args: archive.args } : {}),
          ...(archive.bare ? { bare: true as const } : {}),
          platform,
          timeoutMs,
          signal,
          onOutput,
        })
        // A vendor file with no hash from the registry is installed, and the measured hash logged.
        if (!archive.sha256) {
          diagnostics.log(
            'warn',
            `${archive.url} has no SHA-256 in the registry; installed the file with ${installed.sha256}.`,
          )
        }
        await this.detect(h)
        if (h.detection?.state === 'available') return
        throw new Error(t('agent.binaryInstall.incomplete', { agent }))
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

  /** Runs an install or update as the harness's task, with its progress, failure and cancel. */
  private async runTask(
    h: Harness,
    kind: AgentTask['kind'],
    command: string,
    work: (signal: AbortSignal, onOutput: (text: string) => void) => Promise<void>,
    failure: (message: string) => string,
    method: AgentTask['method'] = null,
  ): Promise<void> {
    // Nothing installs once the quit has begun, as though cancelled at once.
    if (this.stopped) return
    const abort = new AbortController()
    h.taskOutput.clear()
    h.task = { kind, state: 'running', command, method, error: null }
    h.taskAbort = abort
    this.emit(this.home(h))
    const run = (async () => {
      try {
        await work(abort.signal, (text) => this.onTaskOutput(h, text))
        h.task = null
      } catch (error) {
        if (abort.signal.aborted) {
          h.task = null
          return
        }
        const message = failure((error as Error).message)
        this.deps.diagnostics.event(h.def.id, `${kind} failed`, message)
        h.task = { kind, state: 'failed', command, method, error: message }
        throw new HostError('agent_error', message, { agentId: h.def.id })
      } finally {
        h.taskAbort = null
        this.emit(this.home(h))
      }
    })()
    h.taskRun = run
    try {
      await run
    } finally {
      if (h.taskRun === run) h.taskRun = null
    }
  }

  /**
   * Stops a running install or update, its process tree and its partial directory included, or
   * clears one that failed. Resolves once it has stopped.
   */
  async cancelTask(agentId: AgentId): Promise<void> {
    const { h } = this.slot(agentId)
    if (h.task?.state === 'failed') {
      h.task = null
      this.emit(this.home(h))
      return
    }
    if (h.task?.state === 'running') {
      h.taskAbort?.abort()
      await h.taskRun?.catch(() => {})
      return
    }
    // A package harness's first-use install, whether a start or Install asked for it.
    if (h.installAbort) {
      h.installAbort.abort()
      await Promise.all([
        h.installing?.catch(() => {}),
        ...this.agentsOf(h).map((slot) => slot.starting?.catch(() => {})),
      ])
    }
  }

  /**
   * A failed task whose aim was reached some other way: the harness was installed meanwhile, such
   * as by a program picked in Settings, or the update it was for is no longer offered.
   */
  private taskSettled(h: Harness): boolean {
    if (h.task?.kind === 'update') return this.updateOf(h) === null && !this.cliUpdateVersion(h)
    const adapter = h.detection?.state === 'available' ? h.detection.adapter : null
    return h.detection?.state === 'available' && (!adapter || !!adapter.current)
  }

  private onTaskOutput(h: Harness, text: string): void {
    this.deps.diagnostics.stderr(h.def.id, text)
    h.taskOutput.push(text)
    const home = this.home(h)
    home.progressTimer ??= setTimeout(() => {
      home.progressTimer = null
      this.emit(home)
    }, this.timings.progressMs)
  }

  /** Clears `failed` and starts the agent again when live sessions need it. */
  async retry(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    if (slot.state === 'failed') {
      slot.failures = []
      slot.state = 'available'
      slot.detail = null
      await this.detect(slot.h)
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
    // An install runs for the whole harness, so only a quit stops it.
    if (this.stopped) {
      slot.h.installAbort?.abort(QUIT_REASON)
      if (slot.h.installing) await slot.h.installing.catch(() => {})
    }
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
  private letGo(slot: Slot, launched: AgentRun, info: ExitInfo): void {
    if (slot.launched !== launched) return
    const { diagnostics } = this.deps
    diagnostics.event(slot.id, 'stop failed', describeExit(info))
    diagnostics.log('warn', `${slot.name} did not stop: ${describeExit(info)}`)
    slot.runtime?.connection.close()
    slot.launched = null
    slot.runtime = null
    this.givenUp.set(launched, slot)
    this.emitProcesses()
    void this.reapTree(slot, launched)
    // A start that failed reports itself.
    if (slot.starting) return
    slot.state = slot.h.detection?.state ?? 'available'
    slot.detail = null
    this.emit(slot)
  }

  /** Only a quit is short of time, and only it gets the process tools' short limits. */
  private tools(): ToolOptions {
    return { quitting: this.stopped }
  }

  private noteTree(launched: AgentRun): Promise<void> {
    const { trees } = this.deps
    if (!trees || launched.pid === null || launched.hasExited) return Promise.resolve()
    return trees.note({ pid: launched.pid, startedAt: launched.startedAt }, this.tools())
  }

  /** What the agent's process left behind once it exited: CLIs, servers, commands it ran. */
  private reapTree(slot: Slot, launched: AgentRun): Promise<void> {
    const { trees } = this.deps
    if (!trees || launched.pid === null) return Promise.resolve()
    const root = { pid: launched.pid, startedAt: launched.startedAt }
    return trees.reap(root, slot.name, this.tools())
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
    const harnesses = [...this.harnesses.values()]
    for (const h of harnesses) h.taskAbort?.abort(QUIT_REASON)
    const stops = Promise.all([
      this.updateCheck,
      ...harnesses.map((h) => h.taskRun?.catch(() => {})),
      ...slots.map((slot) => this.stop(slot.id)),
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
          `${slot.name} had not stopped ${this.timings.quitStopMs / 1000} s into the quit; killing it`,
        )
        return launched.kill()
      }),
    )
  }

  // Sign-in, account and limits.

  private connectionHooks(slot: Slot): ConnectionHooks {
    const { diagnostics } = this.deps
    const agentId = slot.id
    return {
      traffic: (direction, message) => {
        diagnostics.traffic(agentId, direction, message)
        for (const run of this.processesOf(slot)) {
          if (run.pid != null) this.deps.trees?.active({ pid: run.pid, startedAt: run.startedAt })
        }
      },
      account: (account) => this.setAccount(slot, account),
      ignored: (sessionId, what) =>
        diagnostics.event(agentId, 'ignored', sessionId ? `${what} (session ${sessionId})` : what),
      log: (level, message) => diagnostics.log(level, `${slot.name}: ${message}`),
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
    if (wasRequired && slot.signIn === 'signed-in') this.hooks.signedIn(slot.id)
    if (slot.def.id === 'claude-code' && account.kind === 'account') {
      void this.readTier(slot, slot.account)
    }
  }

  /** Adds the subscription's tier, which only Claude Code's own `.claude.json` holds. */
  private async readTier(slot: Slot, account: AgentAccount): Promise<void> {
    const { platform } = this.deps
    const env = this.deps.env.agentEnv(slot.id)
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
    if (!this.hasLimits(agentId)) return
    await this.detectAll()
    if (slot.signIn === 'required' || (!slot.runtime && slot.h.detection?.state !== 'available')) {
      return
    }
    if (slot.limitsRun) return slot.limitsRun
    if (Date.now() - slot.limitsReadAt < this.timings.limitsMs) return
    slot.limitsRun = this.readLimits(slot).finally(() => {
      slot.limitsRun = null
    })
    return slot.limitsRun
  }

  /** Whether the agent tells its plan limits: from its connection, or from its report. */
  hasLimits(agentId: AgentId): boolean {
    const slot = this.slots.get(agentId)
    return (
      !!slot && (limitsReport(slot.def.id) !== null || this.driver(slot).reads?.limits === true)
    )
  }

  /** Whether the agent tells what fills a session's context: from its connection, or its report. */
  hasContext(agentId: AgentId): boolean {
    const slot = this.slots.get(agentId)
    return !!slot && (hasContextReport(slot.def.id) || this.driver(slot).reads?.context === true)
  }

  /** The limits from the connection when it reads them, else from the agent's report. */
  private async readLimits(slot: Slot): Promise<void> {
    const runtime = await this.ensureReady(slot.id)
    const { connection } = runtime
    const report = limitsReport(slot.def.id)
    let limits: PlanLimit[]
    let now: number
    if (connection.readLimits) {
      try {
        limits = await connection.readLimits()
      } catch (error) {
        throw this.limitsError(slot, error)
      }
      now = Date.now()
      slot.limitsReadAt = now
    } else if (report) {
      const read = await this.reportLimits(slot, runtime, report)
      if (!read) return
      limits = read.limits
      now = read.now
    } else {
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

  /** Runs the agent's report in a hidden session; null when it gave none Kettu can read. */
  private async reportLimits(
    slot: Slot,
    runtime: AgentRuntime,
    report: LimitsReport,
  ): Promise<{ limits: PlanLimit[]; now: number } | null> {
    const dir = this.deps.reportsDir
    await mkdir(dir, { recursive: true })
    const log = (message: string): void => this.deps.diagnostics.log('warn', message)
    let messages: string[]
    try {
      messages = await runReport(
        runtime,
        async () => {
          const setup = await runtime.connection.newSession(dir, { hidden: 'limits' })
          // Only while none are known: the empty folder's defaults never replace a session's.
          if (!this.hooks.optionsKnown(slot.id)) this.hooks.optionsSeen(slot.id, setup.config, dir)
          return setup.sessionId
        },
        report,
        log,
      )
    } catch (error) {
      throw this.limitsError(slot, error)
    }
    const now = Date.now()
    slot.limitsReadAt = now
    const limits = messages
      .map((text) => report.parse(text, now))
      .findLast((parsed) => parsed !== null)
    if (!limits) {
      log(`${slot.name}: ${report.command} gave no report Kettu can read`)
      return null
    }
    return { limits, now }
  }

  private limitsError(slot: Slot, error: unknown): HostError {
    if (error instanceof AgentRequestError && error.kind === 'auth_required') {
      this.authRequired(slot.id)
    }
    return agentError(error)
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
    const agentId = slot.id
    const log = (message: string): void =>
      this.deps.diagnostics.log('warn', `${slot.name}: ${message}`)
    // A limits report running meanwhile reads them too.
    await slot.limitsRun?.catch(() => {})
    if (slot.signIn === 'required') return
    const runtime = this.runtime(agentId)
    if (!runtime?.connection.hiddenSessions) return
    try {
      await this.readInHiddenSession(slot, runtime, log, folder)
    } catch (error) {
      if (error instanceof AgentRequestError && error.kind === 'auth_required') {
        this.authRequired(agentId)
        return
      }
      log(`could not read its options: ${agentError(error).message}`)
    }
  }

  /**
   * Reads the config options of an agent none are cached for, for the agent menu while New
   * session has no folder: starts the agent if it is not running, installing what its first start
   * needs, then reads them as readOptions does in the hidden folder. Unlike readOptions it rejects
   * with the reason, which the menu shows. An agent that must sign in first, or whose hidden
   * sessions would leave a trace, is not read.
   */
  async readFirstOptions(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    const runtime = await this.ensureReady(agentId)
    await slot.limitsRun?.catch(() => {})
    if (slot.signIn === 'required' || !runtime.connection.hiddenSessions) return
    const log = (message: string): void =>
      this.deps.diagnostics.log('warn', `${slot.name}: ${message}`)
    let read: boolean
    try {
      read = await this.readInHiddenSession(slot, runtime, log, undefined)
    } catch (error) {
      if (error instanceof AgentRequestError && error.kind === 'auth_required') {
        this.authRequired(agentId)
        return
      }
      throw agentError(error)
    }
    if (!read) {
      throw new HostError(
        'agent_unavailable',
        t('agent.noOptions', {
          agent: slot.name,
          seconds: String(this.timings.optionsMs / 1000),
        }),
      )
    }
  }

  /**
   * `session/new` in the folder, bounded by `optionsMs`, then the session's removal. False when
   * no answer came in time.
   */
  private async readInHiddenSession(
    slot: Slot,
    runtime: AgentRuntime,
    log: (message: string) => void,
    folder: string | undefined,
  ): Promise<boolean> {
    const agentId = slot.id
    const remove = (sessionId: string): Promise<void> =>
      runtime.connection.removeHidden(sessionId, (message) =>
        log(`could not remove the session its options were read in: ${message}`),
      )
    const dir = folder ?? this.deps.reportsDir
    if (!folder) await mkdir(dir, { recursive: true })
    const opening = runtime.connection.newSession(dir, { hidden: 'options' })
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
        (late) => remove(late.sessionId),
        () => {},
      )
      return false
    }
    try {
      if (setup.config.length > 0) this.hooks.optionsSeen(agentId, setup.config, dir)
      this.signedIn(agentId)
    } finally {
      const removing = remove(setup.sessionId)
      slot.optionsRemoval = removing
      try {
        await removing
      } finally {
        slot.optionsRemoval = null
      }
    }
    return true
  }

  /** Where the agent reads its configuration and which CLI its adapter runs, for its page. */
  async details(agentId: AgentId): Promise<AgentDetails> {
    const slot = this.slot(agentId)
    await this.detectAll()
    const { launch, id: harnessId } = slot.def
    const adapter = slot.h.detection?.state === 'available' ? slot.h.detection.adapter : null
    // The install in use, as for diagnostics: the one a start picks, or the fallback until then.
    const inUse = adapter?.current?.dir ?? adapter?.fallback?.dir
    return readAgentDetails(harnessId, {
      getEnv: (name) => this.deps.env.get(name, agentId),
      chosen: this.chosenFolder(slot),
      home: os.homedir(),
      platform: this.deps.platform,
      adapterDir:
        launch.kind === 'package'
          ? (inUse ?? path.join(this.deps.adaptersDir, harnessId, launch.version))
          : null,
      log: (level, message) => this.deps.diagnostics.log(level, message),
    })
  }

  /** The places, one per agent with an `mcpConfig`, where each keeps MCP servers of its own. */
  async mcpPlaces(): Promise<McpStatus['places']> {
    const { platform } = this.deps
    const places: McpStatus['places'] = []
    for (const slot of this.slots.values()) {
      const config = slot.def.mcpConfig
      if (!config) continue
      const location = await mcpLocation(
        slot.def.id,
        (name) => this.deps.env.get(name, slot.id),
        os.homedir(),
        platform,
        this.chosenFolder(slot),
        (level, message) => this.deps.diagnostics.log(level, message),
      )
      if (!location) continue
      places.push({
        agentId: slot.id,
        path: location.path,
        exists: location.exists,
        env: location.env,
        chosen: location.chosen,
        project: config.project,
        listCommand: config.listCommand ?? null,
      })
    }
    return places
  }

  /** What the agents reported in an earlier run, shown until each reports again. */
  restore(file: AgentsFile): void {
    for (const [agentId, entry] of Object.entries(file.agents) as [
      AgentId,
      AgentsFile['agents'][AgentId],
    ][]) {
      const slot = this.slots.get(agentId)
      if (!slot || !entry) continue
      slot.account = entry.account
      slot.limits = new Map(entry.limits.map((limit) => [limit.window, limit]))
      slot.initRecord = entry.init ?? null
      slot.apiKey = entry.apiKey === true
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
    if (!slot.runtime && (slot.h.detection?.state !== 'available' || !slot.h.detection.spec)) return
    if (this.hasLimits(agentId)) await this.refreshLimits(agentId)
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
    const detection = slot.h.detection
    if (detection?.state === 'available') {
      const spec = slot.state === 'ready' || slot.state === 'starting' ? slot.launchSpec : null
      const shown = spec ?? detection.spec
      if (shown) return shown.display
    }
    const override = this.deps.settings().agents[slot.def.id]?.binaryPath ?? null
    return displayCommand(
      slot.def,
      this.deps.electronPath,
      override,
      this.deps.adaptersDir,
      this.deps.sessionRouterPath ?? null,
    )
  }

  /**
   * The agent's own folder, which Kettu sets in its harness's variable: an added agent's, or one a
   * default agent was given before agents could be added; null at the harness's default.
   */
  private chosenFolder(slot: Slot): string | null {
    if (!slot.def.configVariable) return null
    if (slot.added) return slot.added.configDir
    return this.deps.settings().agents[slot.def.id]?.configDir ?? null
  }

  /** Whether Kettu's MCP server is on for this agent, from the settings. */
  private kettuOn(agentId: AgentId): boolean {
    return !this.deps.settings().mcp.kettu.off.includes(agentId)
  }

  // API keys.

  /**
   * Hands the harness an API key for this agent to keep: Claude Code's in its folder's
   * settings.json, Codex's through `codex login --with-api-key`. A process that runs keeps its
   * credentials until it stops, so an idle one is stopped and the next start uses the key.
   */
  async setApiKey(agentId: AgentId, input: ApiKeyInput): Promise<void> {
    const slot = this.slot(agentId)
    await this.detectAll()
    const checked = checkApiKey(input, slot.def.id === 'claude-code')
    if (slot.def.id === 'claude-code') {
      await writeClaudeKey(this.settingsFile(slot), checked)
    } else if (slot.def.id === 'codex') {
      await this.runCodexLogin(slot, ['login', '--with-api-key'], checked.key)
    } else {
      throw invalidParams(`${slot.def.name} takes no API key from Kettu`)
    }
    this.deps.diagnostics.event(agentId, 'api key', 'set')
    slot.apiKey = true
    await this.credentialsChanged(slot)
  }

  /** Removes what `setApiKey` handed over: the variables it wrote, or Codex's login. */
  async clearApiKey(agentId: AgentId): Promise<void> {
    const slot = this.slot(agentId)
    await this.detectAll()
    if (slot.def.id === 'claude-code') await clearClaudeKey(this.settingsFile(slot))
    else if (slot.def.id === 'codex') await this.runCodexLogin(slot, ['logout'])
    else throw invalidParams(`${slot.def.name} takes no API key from Kettu`)
    this.deps.diagnostics.event(agentId, 'api key', 'cleared')
    slot.apiKey = false
    await this.credentialsChanged(slot)
  }

  /** The agent's settings file, where Claude Code reads the variables of its `env`. */
  private settingsFile(slot: Slot): string {
    const { platform } = this.deps
    const env = this.deps.env.agentEnv(slot.id)
    const file = configLocations(
      slot.def.id,
      (name) => getEnv(env, name, platform),
      os.homedir(),
      platform,
      this.chosenFolder(slot),
    ).find((location) => location.id === 'settings')?.candidates[0]
    if (!file) throw new Error(`${slot.name} has no settings file`)
    return file
  }

  /** Runs the user's `codex` with the agent's folder, feeding it `input`, as its sign-in does. */
  private async runCodexLogin(slot: Slot, args: string[], input?: string): Promise<void> {
    const program = this.userProgram(slot.h)
    const detection = slot.h.detection
    if (!program) {
      throw new HostError(
        'agent_unavailable',
        detection && detection.state !== 'available'
          ? detection.detail
          : t('agent.notAvailable', { agent: slot.name }),
      )
    }
    const timeoutMs = this.timings.optionsMs
    const result = await (this.deps.runProgram ?? runProgram)({
      program: program.path,
      args,
      cwd: os.homedir(),
      env: this.deps.env.agentEnv(slot.id),
      platform: this.deps.platform,
      timeoutMs,
      ...(input !== undefined ? { input } : {}),
    })
    const failure = programFailure('codex', result, timeoutMs)
    if (failure) throw new HostError('agent_error', failure)
  }

  /** The account and limits belong to the old credentials; an idle process goes with them. */
  private async credentialsChanged(slot: Slot): Promise<void> {
    slot.account = null
    slot.limits.clear()
    slot.limitsReadAt = 0
    slot.signIn = 'unknown'
    if (slot.runtime && this.hooks.liveSessions(slot.id) === 0) await this.stopProcess(slot)
    this.emit(slot)
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

  /** The configuration folder the environment gives the harness, without an agent's own. */
  environmentConfig(agentId: AgentId): string | null {
    const slot = this.slots.get(agentId)
    if (!slot?.def.configVariable) return null
    const { platform } = this.deps
    const env = this.deps.env.agentEnv()
    const locations = configLocations(
      slot.def.id,
      (name) => getEnv(env, name, platform),
      os.homedir(),
      platform,
    )
    return locations.find((location) => location.id === 'folder')?.candidates[0] ?? null
  }

  /** What a terminal sign-in runs: the command the agent names, or its launch command. */
  private signInCommand(
    slot: Slot,
    display: CommandWords,
    method: AuthMethodInfo,
    folderEnv: Record<string, string>,
  ): string {
    const env = { ...display.env, ...method.env, ...folderEnv }
    if (method.command) {
      return formatCommand({ command: method.command, args: method.args, env }, this.deps.platform)
    }
    return formatCommand(
      // pi-acp 0.0.34's only method just runs the `requires` program, so it runs alone.
      slot.def.signInWithCli && slot.h.requiresProgram
        ? { command: slot.h.requiresProgram, args: [], env: {} }
        : { command: display.command, args: [...display.args, ...method.args], env },
      this.deps.platform,
    )
  }

  status(agentId: AgentId): AgentStatus {
    const slot = this.slot(agentId)
    const { h } = slot
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
        ? { command: this.signInCommand(slot, display, method, folderEnv) }
        : {}),
    }))
    const capabilities = init?.capabilities ?? rememberedCapabilities(slot)
    const { launch } = slot.def
    const detection = h.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    const update = this.updateOf(h)
    const harnessSettings = this.deps.settings().agents[slot.def.id]
    const cliVersion = this.cliUpdateVersion(h)
    const cliCommand = cliVersion ? (this.cliCommands.get(h) ?? null) : null
    return {
      id: slot.id,
      name: slot.name,
      harnessId: slot.def.id,
      harnessName: slot.def.name,
      isDefault: !slot.added,
      hidden: !slot.added && harnessSettings?.hidden === true,
      apiKey:
        slot.def.id === 'claude-code' || slot.def.id === 'codex'
          ? { set: slot.apiKey, providers: slot.def.id === 'claude-code' }
          : null,
      state: slot.state,
      // For an agent with a `requires` program its own version is the one shown, never the adapter's.
      version: slot.def.requires
        ? (h.requiresVersion ?? h.binaryVersion ?? null)
        : (init?.version ?? h.binaryVersion ?? null),
      package:
        launch.kind === 'package'
          ? {
              name: launch.package,
              version: (adapter?.current ?? adapter?.fallback)?.version ?? launch.version,
              // An install below the pin runs too, when the pinned one cannot be installed.
              installed: !!(adapter?.current ?? adapter?.fallback),
              ...(launch.library ? { isSdk: true as const } : {}),
            }
          : null,
      signIn: slot.signIn,
      authMethods,
      canLogout: capabilities?.logout ?? false,
      account: slot.account,
      limits: [...slot.limits.values()],
      detail: slot.detail ?? h.adapterNote,
      installUrl:
        slot.state === 'not-installed' ||
        slot.state === 'node-missing' ||
        slot.state === 'node-outdated'
          ? slot.def.install.url
          : null,
      progress:
        slot.state === 'starting' || slot.state === 'installing' ? slot.progress.lastLines(5) : [],
      launchCommand: formatCommand(display, platform),
      binaryOverride: harnessSettings?.binaryPath ?? null,
      binaryCommand: launch.kind === 'binary' ? launch.command : null,
      update,
      updateCheckedAt: this.checksUpdates(h) ? h.checkedAt : null,
      // Skipped when every update on offer was dismissed: Kettu's package's and the CLI's.
      updateSkipped:
        (!update || sameUpdate(update, h.skipped)) &&
        (!cliVersion || cliVersion === h.cliSkipped) &&
        (!!update || !!cliVersion),
      task: h.task ? { ...h.task, progress: h.taskOutput.lastLines(5) } : null,
      installMethods: h.installPlans.map(({ id, label, command, available }) => ({
        id,
        label,
        command,
        available,
      })),
      cli: slot.def.cli
        ? {
            command: slot.def.cli.command,
            installed: detection?.cli ?? null,
            method: h.cliMethod,
            update: cliVersion && cliCommand ? { version: cliVersion, command: cliCommand } : null,
          }
        : null,
      configDir: config
        ? { runs: config.folder, active: active?.folder ?? null, created: !!slot.added?.created }
        : null,
      kettuServer: {
        runs: this.kettuOn(slot.id),
        active: this.running(slot) ? (slot.runtime?.kettu ?? null) : null,
      },
      capabilities: {
        loadSession: capabilities?.loadSession ?? false,
        listSessions: capabilities?.listSessions ?? false,
        resumeSession: capabilities?.resumeSession ?? false,
        closeSession: capabilities?.closeSession ?? false,
        deleteSession: capabilities?.deleteSession ?? false,
        forkSession: capabilities?.forkSession ?? false,
        forkAtMessage: capabilities?.forkAtMessage ?? false,
        steering: capabilities?.steering ?? false,
        reports: this.hasLimits(slot.id),
        context: this.hasContext(slot.id),
        account: slot.def.reportsAccount ?? false,
        progressNotes: slot.def.progressNotes ?? false,
        mcpHttp: capabilities?.mcpHttp ?? null,
        prompt: capabilities?.prompt ?? null,
      },
    }
  }

  statuses(): AgentStatus[] {
    return [...this.slots.keys()].map((agentId) => this.status(agentId))
  }

  /** The files of the adapter version in use, for diagnostics. */
  async adapterFiles(agentId: AgentId): Promise<{ installed: unknown; lock: unknown } | null> {
    const detection = this.slots.get(agentId)?.h.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    if (!adapter) return null
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
    this.deps.diagnostics.stderr(slot.id, text)
    if (slot.state === 'starting') this.onProgress(slot, text)
  }

  /** npm's output while installing, or the agent's stderr while starting. */
  private onProgress(slot: Slot, text: string): void {
    if (slot.state === 'installing') this.deps.diagnostics.stderr(slot.id, text)
    slot.progress.push(text)
    // Progress lines arrive fast while npm downloads; a few status events a second is enough.
    slot.progressTimer ??= setTimeout(() => {
      slot.progressTimer = null
      this.emit(slot)
    }, this.timings.progressMs)
  }

  /**
   * Sends the status of the slot and of the other agents of its harness that changed, since a
   * harness's detection, task and updates show in each of them.
   */
  private emit(slot: Slot): void {
    const { h } = slot
    if (h.task?.state === 'failed' && this.taskSettled(h)) h.task = null
    void this.refreshCliCommand(h)
    for (const agent of this.agentsOf(h)) {
      const status = this.status(agent.id)
      const json = JSON.stringify(status)
      if (json !== agent.lastStatus) {
        agent.lastStatus = json
        this.deps.status(status)
      }
      const remembered = rememberedJson(agent)
      if (remembered !== agent.remembered) {
        agent.remembered = remembered
        this.remember()
      }
    }
    const update = updateJson(h)
    if (update !== h.rememberedUpdate) {
      h.rememberedUpdate = update
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

  /**
   * The command that updates the user's program, worked out once a newer version is known: it
   * looks up tools such as brew on PATH, which `status` does not wait for.
   */
  private async refreshCliCommand(h: Harness): Promise<void> {
    const key = `${this.cliUpdateVersion(h)}\0${h.cliMethod}\0${this.userProgram(h)?.path}`
    if (!this.cliUpdateVersion(h) || this.cliCommandKeys.get(h) === key) return
    this.cliCommandKeys.set(h, key)
    const plan = await this.cliUpdatePlan(h).catch(() => null)
    if (this.cliCommandKeys.get(h) !== key) return
    if (plan) this.cliCommands.set(h, plan.command)
    else this.cliCommands.delete(h)
    this.emit(this.home(h))
  }

  private remember(): void {
    if (!this.deps.remember) return
    const agents: AgentsFile['agents'] = {}
    for (const [agentId, slot] of this.slots) {
      const entry = rememberedEntry(slot)
      if (entry) agents[agentId] = entry
    }
    this.deps.remember({ version: 1, agents })
  }

  private rememberUpdates(): void {
    if (!this.deps.rememberUpdates) return
    const agents: AgentUpdatesFile['agents'] = {}
    for (const [harnessId, h] of this.harnesses) {
      const entry = updateEntry(h)
      if (entry) agents[harnessId] = entry
    }
    this.deps.rememberUpdates({ version: 1, agents })
  }

  private emitProcesses(): void {
    this.deps.processes(this.processes())
  }

  processes(): AgentProcess[] {
    const running = new Map<AgentRun, Slot>()
    for (const slot of this.slots.values()) {
      for (const run of this.processesOf(slot)) running.set(run, slot)
    }
    for (const [run, slot] of this.givenUp) running.set(run, slot)
    return [...running].flatMap(([run, slot]) =>
      run.pid != null ? [{ agentId: slot.id, pid: run.pid, startedAt: run.startedAt }] : [],
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

/** Maps a failed request to the agent to the port error the renderer acts on. */
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
