// Agent supervision: detection, lazy start, one process per agent, idle stop, crash counting,
// sign-in state and the AgentStatus every port sees. A harness's detection, installs and updates
// are shared by its agents: its default agent and those added with folders of their own.

import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentAccount,
  AgentAuthMethod,
  AgentDetails,
  AgentInstallMethod,
  AgentProvider,
  AgentProviderAction,
  AgentState,
  AgentStatus,
  AgentTask,
  AgentUpdate,
  AutoCompactChange,
  AutoCompactSettings,
  ClaudeSettingChange,
  ClaudeSettings,
  CodebuddySettings,
  CodebuddySiteChange,
  HarnessReason,
  InstallOffer,
  InstalledCli,
  McpStatus,
  ModelProvider,
  PlanLimit,
  PlanResets,
  ProgramMethod,
  ProviderBalance,
  ResetsError,
  ResetSpendCode,
  VersionMoveReason,
} from '@shared/agent-host'
import {
  GROK_CACHED_SIGN_IN,
  GROK_READS_VERSION,
  parseGrokAuthInfo,
  parseGrokBilling,
  type GrokSignIn,
} from './vendor-usage/grok'
import { parseMistralAccount } from './vendor-usage/mistral-vibe'
import { KeychainRefused, parseCursorAbout, type CursorSignIn } from './vendor-usage/cursor'
import { readAuggieAccount } from './vendor-usage/auggie'
import { readCopilotQuota } from './vendor-usage/copilot'
import { readKiloProfile } from './vendor-usage/kilo'
import { readQoderUsage } from './vendor-usage/qoder'
import { storedSignInReader } from './vendor-usage/readers'
import { readerOpen, UsageReadError, type StoredSignInReader } from './vendor-usage/stored-sign-in'
import {
  CODEX_RESETS_VERSION,
  readCodexResets,
  spendCodexReset,
  type CodexPlace,
} from './vendor-usage/codex'
import type { VendorUsage } from './vendor-usage/common'
import {
  ANTIGRAVITY_PLAN_SIGN_INS,
  ANTIGRAVITY_USAGE_VERSION,
  antigravityAuthStateFile,
  antigravityLimitsRead,
  antigravitySignIn,
  antigravitySignInMethod,
} from './vendor-usage/antigravity'
import { readAntigravityUsage } from './antigravity-usage'
import { signsInWithKeyOnly } from '@shared/agents'
import { takesAutoCompact } from '@shared/auto-compact'
import type { AgentProcess, NodeRuntime } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import { agentColor, type AddedAgent, type HostSettings } from '@shared/settings'
import {
  AUTO_AGENT_HARNESSES,
  harnessOf,
  type AgentId,
  type ConfigOption,
  type HarnessId,
} from '@shared/thread'
import { DELEGATED_SIGN_IN } from './acp/sign-in'
import {
  installAdapter,
  NPM_INSTALL_ARGS,
  OMIT_CLI_ARG,
  programFailure,
  readInstallFiles,
  removeInstall,
  removeStaleInstalls,
  removeTree,
  listInstalled,
  runNpm,
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
import {
  decideUpdate,
  fetchBrewLatest,
  fetchLatest,
  type LatestFound,
  type LatestOptions,
} from './agent-updates'
import {
  installArchive,
  listArchiveInstalls,
  programPath,
  removeStaleArchives,
  type ArchiveInstallOptions,
  type InstalledArchive,
} from './archive-install'
import {
  checkApiKey,
  clearClaudeKey,
  clearCodebuddyKey,
  writeClaudeKey,
  writeCodebuddyKey,
  type ApiKeyInput,
} from './api-key'
import {
  clearApiKey as clearDshKey,
  readAccountToken as readDshAccountToken,
  readApiKey as readDshKey,
  readProvider as readDshProvider,
  routeAccount,
  writeApiKey as writeDshKey,
  type Provider as DshRoute,
} from './dsh/credentials'
import { readAccountBalance, type AccountBalance } from './dsh/balance'
import { readClaudeSettings, writeClaudeSetting, type ListedModel } from './claude/user-settings'
import { readCodebuddySite, shellOverrides, writeCodebuddySite } from './codebuddy/user-settings'
import { readAutoCompact, writeAutoCompact, type CompactPlace } from './auto-compact/settings'
import type { CodexRequest } from './codex/rpc'
import { takesSkills } from './marketplace/skill-tools'
import {
  globalInstallOf,
  installedFolder,
  installMethodOf,
  installPlans,
  shellShimTarget,
  uninstallPlan,
  updatePlan,
  type ArchiveEntry,
  type GlobalInstall,
  type InstallPlan,
} from './binary-install'
import {
  detectAgent,
  displayCommand,
  EXTENSIONS_FOLDER,
  programRange,
  type AgentDefinition,
  type AgentProtocol,
  type CommandWords,
  type DetectContext,
  type Detection,
  userProgramFound,
  type LaunchSpec,
} from './catalog'
import { OAUTH_ACCOUNT_LABEL } from './claude/reports'
import {
  AgentRequestError,
  type AgentConnection,
  type AgentInit,
  type AuthMethodInfo,
  type ConnectionHooks,
} from './connection'
import type { Diagnostics } from './diagnostics'
import type { AgentDriver, AgentTransport } from './driver'
import { driverOf, preferredProtocol, protocolFor, type DriverOverrides } from './drivers'
import { HostError, invalidParams } from './errors'
import { findCommand, getEnv, isExecutableFile, type Env } from './find-command'
import {
  fetchManifest,
  inNpmRange,
  isBroken,
  MANIFEST_KEYS,
  parseManifest,
  ruleFor,
  usable,
  verifyManifest,
  type HarnessManifest,
  type HarnessRule,
  type ManifestFetchOptions,
} from './harness-manifest'
import {
  acceptsVersion,
  BUNDLED,
  bundledRelease,
  installsOwn,
  listedRelease,
  minimumOf,
  targetRelease,
  type BundledVersions,
  type TargetRelease,
  type VersionChoice,
} from './harness-versions'
import { HostedRun, type HostedRunHooks } from './hosted-run'
import { t } from './i18n'
import {
  installOffer,
  installsOnStart,
  npmConfigKeys,
  parseNpmConfig,
  type NpmConfig,
} from './install-offer'
import {
  CliVersions,
  shimTarget as cmdShimTarget,
  type CliProbe,
  type CliVersion,
} from './installed-cli'
import { OpenCodeClient } from './opencode/client'
import { OpenCodeConnection } from './opencode/connection'
import type { OpenCodeSessions } from './model-requests/opencode'
import { readProviderUsage, type ProviderUsage } from './opencode/provider-usage'
import { claudeJsonPath, readClaudeProfile } from './plan-tier'
import { QUIT_REASON, type ToolOptions } from './process-tree'
import { formatCommand } from './quote'
import {
  fetchRegistry,
  followsRegistry,
  listingEntries,
  parseRegistry,
  type RegistryAgents,
  type RegistryFetchOptions,
} from './registry'
import { hasContextReport, limitsReport, runReport, type LimitsReport } from './reports'
import { TextRing } from './ring'
import {
  allowedLimit,
  coverWithExtraUsage,
  endExtraUsage,
  mergeReadLimits,
  planWindow,
} from './session-updates'
import type { EnvironmentService } from './shell-env'
import type {
  AgentsFile,
  AgentUpdatesFile,
  HarnessManifestFile,
  RegistryListingFile,
  RememberedInit,
} from './storage'
import { readUvxVersion, uvxFetchArgs, writeUvxVersion } from './uvx-install'
import { compareVersions, versionAtLeast } from './versions'

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
  /** How often the plan limits of the agents with a live session are read in the background. */
  limitsBackgroundMs: number
  /** How long one read of the plan limits may take before later refreshes stop waiting for it. */
  limitsReadMs: number
  /** How long the hidden `session/new` that reads an agent's options may take. */
  optionsMs: number
  /** How long a read of a per-session agent's own waits for its sessions that are opening. */
  openingWaitMs: number
  /** How long one `npm view` of the update check may take. */
  updateViewMs: number
  /** How long after the host starts a due update check waits, so it stays out of startup. */
  updateDelayMs: number
  /** How often updates are checked with npm while the host runs. */
  updateIntervalMs: number
  /** How often the ACP Registry's listing is read while the host runs. */
  registryIntervalMs: number
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
  limitsBackgroundMs: 5 * 60_000,
  limitsReadMs: 90_000,
  optionsMs: 30_000,
  openingWaitMs: 30_000,
  updateViewMs: 20_000,
  updateDelayMs: 60_000,
  updateIntervalMs: 24 * 60 * 60_000,
  registryIntervalMs: 6 * 60 * 60_000,
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
  nodeRuntime: NodeRuntime
  appVersion: string
  env: EnvironmentService
  diagnostics: Diagnostics
  /** Keeps an ACP agent's messages by session, for the Requests pane. */
  acpMessages?: { add(agentId: AgentId, direction: 'in' | 'out', message: unknown): void }
  launcher: AgentLauncher
  settings(): HostSettings
  /** The folder hidden sessions run in: the reports' and the one that reads the options. */
  reportsDir: string
  /** `<userData>/agents`, where package agents are installed. */
  adaptersDir: string
  /** The session router a per-session agent launches through; null without one. */
  sessionRouterPath?: string | null
  /** The bundle of the process that runs Cline's SDK; null without one. */
  clineHostPath?: string | null
  detect?(def: AgentDefinition, ctx: DetectContext): Promise<Detection>
  install?(options: InstallOptions): Promise<InstalledAdapter>
  /** Downloads and extracts a binary agent's release archive. */
  installArchive?(options: ArchiveInstallOptions): Promise<InstalledArchive>
  /** Asks npm for an adapter's newest version and the CLI it carries. */
  fetchLatest?(options: LatestOptions): Promise<LatestFound>
  /** Reads the ACP Registry's listing, whose versions the harnesses Kettu installs follow. */
  fetchRegistry?(options: RegistryFetchOptions): Promise<RegistryAgents>
  /** Reads the body of Kettu's harness compatibility manifest from its download service. */
  fetchManifest?(options: ManifestFetchOptions): Promise<string>
  /** The keys the manifest's signature is checked against; the bundled ones by default. */
  manifestKeys?: readonly string[]
  /** What the manifest's requests say they are, which tells the service the app from the daemon. */
  userAgent?: string
  /** The versions this build bundles; tests give their own. */
  bundled?: BundledVersions
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
  /** Keeps the Registry's listing as last read, for a start without the network. */
  rememberRegistry?(file: RegistryListingFile): void
  /** Keeps the manifest as last read, for a start without the network. */
  rememberManifest?(file: HarnessManifestFile): void
  /** The environment the agent's own process starts with, from the one it would have. */
  launchEnv?(agentId: AgentId, env: Env): Env
  envKeyIsSet?(agentId: AgentId, variable: string): boolean
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
  /** The version of Kettu's own install that last started and answered. */
  ran: string | null = null
  /** With automatic updates off, the version the user last moved to, which a start runs. */
  stay: string | null = null
  /** A new version that failed to start in place of the one before it, and why. */
  failed: { version: string; reason: string } | null = null
  /** The last move automatic updates made, and why, for the harness's page. */
  moved: Move | null = null
  /**
   * The user's CLI version the target's SDK needs, from npm, for a harness whose SDK pins its CLI;
   * null for none.
   */
  targetCli: { version: string; cli: string | null } | null = null
  /** The automatic update installing in the background, apart from the user's tasks. */
  autoRun: Promise<void> | null = null
  autoAbort: AbortController | null = null
  /** The reason an automatic update was last skipped or failed, logged once. */
  autoNote: string | null = null
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
  cliMethod: ProgramMethod | null = null
  /** The package manager's global install it lies in, and the folder its commands name. */
  cliGlobal: GlobalInstall | null = null
  /** A binary agent's version, from its own `--version`, until it starts and reports its own. */
  binaryVersion: string | null = null
  /** The program `binaryVersion` was read from, so an answer for another one is dropped. */
  binaryProgram: string | null = null
  /** The `--version` question that fills `binaryVersion`, while or once it is asked. */
  binaryVersionAsked: Promise<void> | null = null
  /** The `--version` failure already logged, so a repeated detection logs it once. */
  binaryVersionFailure: string | null = null
  /** The program's install routes, found at detection. */
  installPlans: InstallPlan[] = []
  /** The size of each version of Kettu's own package, without its dependencies, as npm gave it. */
  sizes = new Map<string, number>()
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
  /** The harness's preferred interface, while the launch runs on it instead of its protocol. */
  protocol: AgentProtocol | null = null
  /** The version of the program whose preferred interface did not start, which runs without it. */
  preferredFailed: string | null = null
  /** The configuration folder the running launch got, for an agent whose folder can be chosen. */
  launchConfig: RunningConfig | null = null
  intentionalStop = false
  failures: number[] = []
  signIn: AgentStatus['signIn'] = 'unknown'
  account: AgentAccount | null = null
  providers: AgentProvider[] = []
  providersError: string | null = null
  providersRun: Promise<void> | null = null
  providersReadAt = 0
  modelProviders: ModelProvider[] | null = null
  providerActionRun: Promise<void> | null = null
  /** DeepSeek Harness's balance at DeepSeek, on an API key or a DeepSeek account. */
  balance: ProviderUsage | null = null
  /** The DeepSeek Harness sign-in route the balance was read for. */
  balanceRoute: DshRoute | null = null
  balanceRun: Promise<void> | null = null
  balanceReadAt = 0
  limits = new Map<string, PlanLimit>()
  balances: ProviderBalance[] = []
  /** Kettu handed the harness an API key for this agent, which it never reads back. */
  apiKey = false
  /** The capabilities of the last `initialize`, from this run or an earlier one. */
  initRecord: RememberedInit | null = null
  /** The account, limits and capabilities as last remembered, so only a change is written. */
  remembered = ''
  limitsRun: Promise<void> | null = null
  limitsReadAt = 0
  /** Why the last limits read failed; null once one succeeds. */
  limitsError: string | null = null
  /** Codex's reset credits as last read; null while it holds none or none were read. */
  resets: PlanResets | null = null
  resetsError: ResetsError | null = null
  resetsRun: Promise<void> | null = null
  resetsReadAt = 0
  resetsRetry: ReturnType<typeof setTimeout> | null = null
  optionsRun: Promise<void> | null = null
  /** Its sessions opening now, each settled once its start has. */
  openings = new Set<Promise<void>>()
  /** The removal of the hidden session that read the options, once its `session/new` answered. */
  optionsRemoval: Promise<void> | null = null
  progress = new TextRing(8 * 1024)
  /** Stops the sign-in in progress; the agent is not stopped for being idle while it runs. */
  signInAbort: AbortController | null = null
  /** The key of its `keySignIn` changed, so its next start signs in with it. */
  keySignInPending = false
  /** The method a `sharesSignIn` agent is signed in with, as it and its files show; null unknown. */
  signInMethod: string | null = null
  /** The sign-in method the agent's last answer showed; null when it showed none, or none came. */
  answeredSignIn: string | null = null
  /** An answer of this run showed the agent's sign-in, or that it showed none. */
  signInAnswered = false
  /** The sign-in method the agent's own auth state file named when last read. */
  signInFile: string | null = null
  /** It refused its account as one of its `movedAccounts`, until a sign-in or session succeeds. */
  accountRefused = false
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

/** Whether the agent runs each session in a process of its own, through the session router. */
function runsPerSession(def: AgentDefinition): boolean {
  return (def.launch.kind === 'binary' || def.launch.kind === 'package') && !!def.launch.perSession
}

// For diagnostics, which stay in English.
function describeExit(info: ExitInfo): string {
  if (info.error) return info.error
  if (info.signal) return `was stopped by ${info.signal}`
  return `exited with code ${info.code}`
}

function exitText(agent: string, info: ExitInfo): string {
  if (info.closed) return t('agent.exit.closed', { agent })
  if (info.error) return t('agent.exit.error', { agent, error: info.error })
  if (info.signal) return t('agent.exit.signal', { agent, signal: info.signal })
  return t('agent.exit.code', { agent, code: String(info.code) })
}

// A signed-out account is not kept: whether it is still signed out shows once the agent runs.
function rememberedEntry(slot: Slot): AgentsFile['agents'][AgentId] | null {
  const account = slot.account?.kind === 'none' ? null : slot.account
  const limits = [...slot.limits.values()]
  const init = slot.initRecord
  const signIn = slot.answeredSignIn
  return account || limits.length > 0 || init || slot.apiKey || signIn
    ? {
        account,
        limits,
        ...(init ? { init } : {}),
        ...(slot.apiKey ? { apiKey: true } : {}),
        ...(signIn ? { signIn } : {}),
      }
    : null
}

/**
 * The harness's program as its page names it, which one picked in Settings replaces: a binary
 * harness's command, the user's CLI an SDK runs, an npm package's command, which is looked for on
 * PATH, or the package Kettu runs, which is not.
 */
function programOf(def: AgentDefinition): AgentStatus['program'] {
  const { launch } = def
  if (def.cli) return { command: def.cli.command, onPath: true }
  switch (launch.kind) {
    case 'binary':
      return { command: launch.command, onPath: true }
    case 'package':
      return launch.command
        ? { command: launch.command, onPath: true }
        : { command: launch.package, onPath: false }
    case 'uvx':
      return { command: launch.package, onPath: false }
    case 'node-script':
      return null
  }
}

/** A state detection gives a harness that cannot run, for the reason it found. */
function unavailable(state: AgentState): boolean {
  return state === 'not-installed' || state === 'node-missing' || state === 'node-outdated'
}

/**
 * The version that runs: the handshake's, else the program's, else the installed package's, since
 * a package harness has no program to ask and Grok names none in its handshake.
 */
function runningVersion(slot: Slot): string | null {
  const detection = slot.h.detection
  const adapter = detection?.state === 'available' ? detection.adapter : null
  return (
    slot.init?.version ??
    slot.h.binaryVersion ??
    (adapter?.current ?? adapter?.fallback)?.version ??
    null
  )
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
  const runs = {
    ...(h.ran ? { ran: h.ran } : {}),
    ...(h.stay ? { stay: h.stay } : {}),
    ...(h.failed ? { failed: h.failed } : {}),
    ...(h.moved ? { moved: h.moved } : {}),
  }
  if (h.attemptedAt === null && Object.keys(runs).length === 0) return undefined
  return {
    checkedAt: h.checkedAt,
    attemptedAt: h.attemptedAt,
    latest: h.latest,
    ...(h.cliLatest ? { cli: h.cliLatest } : {}),
    ...(h.skipped ? { skipped: h.skipped } : {}),
    ...(h.cliSkipped ? { skippedCli: h.cliSkipped } : {}),
    ...runs,
  }
}

type Move = NonNullable<NonNullable<AgentStatus['automatic']>['moved']>

const sameVersion = (a: string, b: string | null | undefined): boolean =>
  !!b && compareVersions(a, b) === 0

// npm's and pnpm's shims are under 1 KB; a larger file is not one of them.
const SHIM_LIMIT = 64 * 1024

/**
 * The package file a shim at `file` starts: a shell script off Windows, a `.cmd` on it. Null for
 * any other file.
 */
async function shimTarget(file: string, platform: Platform): Promise<string | null> {
  if (platform === 'win32' && !/\.(?:cmd|bat)$/i.test(file)) return null
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size > SHIM_LIMIT) return null
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  return platform === 'win32' ? cmdShimTarget(text, file) : shellShimTarget(text, file)
}

/** An archive the registry gives no SHA-256 for, which only the user's click installs. */
function unhashed(target: TargetRelease): boolean {
  return target.kind === 'archive' && !target.entry.sha256
}

/** Whether two updates name the same adapter and CLI versions. */
function sameUpdate(a: AgentUpdate | null, b: AgentUpdate | null): boolean {
  return !!a && !!b && a.adapterVersion === b.adapterVersion && a.cliVersion === b.cliVersion
}

/**
 * A default agent is registered when the user added it. The fake agent exists only in development
 * builds and is on unless it was removed.
 */
function registeredByDefault(harnessId: HarnessId, agents: HostSettings['agents']): boolean {
  const enabled = agents[harnessId]?.enabled
  return enabled === true || (AUTO_AGENT_HARNESSES.includes(harnessId) && enabled !== false)
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
  private registryTimer: ReturnType<typeof setTimeout> | null = null
  /** The Registry's listing as last read, live or from disk; null until one is. */
  private listing: RegistryAgents | null = null
  private listingRead: Promise<string | null> | null = null
  private listingReadAt: number | null = null
  private readonly bundled: BundledVersions
  /** The manifest this build bundles, once verified; null when it bundles none. */
  private readonly bundledManifest: HarnessManifest | null
  /** The manifest as last read from the download service, live or from disk; null until one is. */
  private readManifest: HarnessManifest | null = null
  private manifestReadAt: number | null = null
  private limitsTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private readonly cliVersions: CliVersions
  /** The update command for each harness's user program, and what it was worked out for. */
  private readonly cliCommands = new Map<Harness, string>()
  private readonly cliCommandKeys = new Map<Harness, string>()
  /** npm's configuration for the install window, by the keys asked, until the next redetect. */
  private readonly npmConfigs = new Map<string, Promise<NpmConfig | null>>()
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
    this.bundled = deps.bundled ?? BUNDLED
    const bundledManifest = this.bundled.manifest
      ? verifyManifest(this.bundled.manifest, 0, this.manifestKeys)
      : null
    if (bundledManifest && !bundledManifest.ok) {
      deps.diagnostics.log(
        'warn',
        `The bundled harness manifest is not used: ${bundledManifest.reason}`,
      )
    }
    this.bundledManifest = bundledManifest?.ok ? bundledManifest.manifest : null
    this.cliVersions = deps.cliVersions ?? new CliVersions({ platform: deps.platform })
    for (const def of deps.catalog) {
      const h = new Harness(def)
      this.harnesses.set(def.id, h)
      this.slots.set(def.id, new Slot(def.id, h, null))
    }
    this.syncAgents(deps.settings().addedAgents)
  }

  has(agentId: AgentId): boolean {
    const slot = this.slots.get(agentId)
    return !!slot && (!!slot.added || registeredByDefault(slot.def.id, this.deps.settings().agents))
  }

  private registeredSlot(agentId: AgentId): Slot {
    if (!this.has(agentId)) throw new HostError('agent_unavailable', t('agent.removed'))
    return this.slot(agentId)
  }

  /** Whether the user turned the agent off: it keeps everything but never starts. */
  isDisabled(agentId: AgentId): boolean {
    return this.deps.settings().disabledAgents.includes(agentId)
  }

  /** Rejects with `agent_unavailable` while the agent is turned off. */
  assertEnabled(agentId: AgentId): void {
    if (!this.isDisabled(agentId)) return
    throw new HostError('agent_unavailable', t('agent.disabled', { agent: this.name(agentId) }), {
      agentId,
    })
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

  toolGateway(agentId: AgentId): boolean {
    return this.slots.get(agentId)?.def.toolGateway ?? false
  }

  private slot(agentId: AgentId): Slot {
    const slot = this.slots.get(agentId)
    if (!slot) throw invalidParams(t('agent.unknown', { agent: agentId }))
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
      this.noteStartMoves()
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
      nodeRuntime: this.deps.nodeRuntime,
      binaryOverride: harnessSettings?.binaryPath ?? null,
      node,
      adaptersDir: this.deps.adaptersDir,
      sessionRouterPath: this.deps.sessionRouterPath ?? null,
      versions: this.versionChoice(h),
      manifestRule: this.rule(h),
      isExecutable,
      probeCli: (program, cliEnv, words) => this.askVersion(program, cliEnv, words),
    })
    const adapter = detection.state === 'available' ? detection.adapter : null
    const running = adapter?.current ?? adapter?.fallback
    const log = (level: 'info' | 'warn' | 'error', message: string): void =>
      this.deps.diagnostics.log(level, message)
    const [installedCli, plans, route] = await Promise.all([
      running ? readCliVersion(h.def.id, running.dir, log) : null,
      h.def.installs
        ? installPlans(h.def.installs, {
            platform,
            archive: this.archiveToInstall(h),
            env,
            npm: node.npmPath,
            root: this.deps.adaptersDir,
            agentId: h.def.id,
            isExecutable,
          })
        : [],
      this.cliMethod(h, detection),
    ])
    const effective: Detection = harnessSettings?.uninstalled
      ? {
          state: 'not-installed',
          detail: t('detect.uninstalled', { agent: h.def.name }),
          reason: { kind: 'not-installed' },
        }
      : detection
    h.detection = effective
    h.installedCli = installedCli
    h.installPlans = plans
    h.cliMethod = route.method
    h.cliGlobal = route.global
    // A binary agent's own version is asked in the background, so detection never waits for it.
    // A routed program's launch command is the runtime the router runs on, not the program.
    const program =
      h.def.launch.kind === 'binary' && effective.state === 'available'
        ? (effective.cli?.path ?? effective.spec?.command ?? null)
        : null
    if (program !== h.binaryProgram) {
      h.binaryProgram = program
      h.binaryVersion = null
      h.binaryVersionFailure = null
      h.binaryVersionAsked = null
    }
    for (const slot of this.agentsOf(h)) {
      // A running, installing, failed or recovering agent keeps its lifecycle state.
      const idle = !slot.launched && !slot.starting && !h.installing && slot.state !== 'failed'
      if (idle) {
        slot.state = effective.state
        slot.detail = effective.state === 'available' ? null : effective.detail
      }
    }
    this.emit(this.home(h))
    if (program) h.binaryVersionAsked = this.askBinaryVersion(h, program, env)
  }

  /**
   * How the user's own CLI, or a binary harness's program, was installed, and the package
   * manager's global install it lies in, if any.
   */
  private async cliMethod(
    h: Harness,
    detection: Detection,
  ): Promise<{ method: ProgramMethod | null; global: GlobalInstall | null }> {
    const none = { method: null, global: null }
    const { platform } = this.deps
    const installs = { ...h.def.installs }
    installs.npm ??= this.programPackage(h) ?? undefined
    const found =
      detection.cli?.path ??
      (h.def.launch.kind === 'binary' && detection.state === 'available'
        ? detection.spec?.command
        : undefined)
    if (!found) return none
    const routeOf = (file: string) => {
      const method = installMethodOf(installs, file, { platform, home: os.homedir() })
      if (!method) return null
      const global = installs.npm ? globalInstallOf(file, installs.npm, platform) : null
      return { method, global: global?.manager === method ? global : null }
    }
    const real = await realpath(found).catch(() => found)
    const direct = routeOf(real)
    if (direct) return direct
    // pnpm's global commands are shell scripts, and every package manager's are `.cmd` files on
    // Windows, which start the package's file.
    const target = await shimTarget(found, platform)
    if (!target) return none
    return routeOf(target) ?? routeOf(await realpath(target).catch(() => target)) ?? none
  }

  /**
   * The npm package of the harness's own program, which npm, pnpm, bun or yarn may have installed
   * globally: its vendor's npm route, or a package harness's own package.
   */
  private programPackage(h: Harness): string | null {
    const { installs, launch } = h.def
    return installs?.npm ?? (launch.kind === 'package' ? launch.package : null)
  }

  /** A program's `--version` answer: the test's probe, or the cache the CLIs are asked through. */
  private askVersion(program: string, env: Env, words?: readonly string[]): Promise<CliVersion> {
    return this.deps.probeCli
      ? this.deps.probeCli(program, env, words)
      : this.cliVersions.probe(program, env, words)
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

  /**
   * The harnesses whose user program the last detection found, in catalog order; call after
   * `detectAll`.
   */
  userPrograms(): HarnessId[] {
    return [...this.harnesses.values()]
      .filter((h) => !!h.detection && userProgramFound(h.def, h.detection, this.deps.adaptersDir))
      .map((h) => h.def.id)
  }

  async check(agentId?: AgentId): Promise<AgentStatus[]> {
    await this.detectAll()
    const harnesses = agentId ? [this.slot(agentId).h] : [...this.harnesses.values()]
    await Promise.all(harnesses.map((h) => this.detect(h)))
    return this.statuses()
  }

  async reloadEnvironment(): Promise<AgentStatus[]> {
    await this.deps.env.reload()
    return this.redetect()
  }

  /** Detects every harness again in the environment as it is now. */
  async redetect(): Promise<AgentStatus[]> {
    this.cliVersions.clear()
    this.npmConfigs.clear()
    await Promise.all([...this.harnesses.values()].map((h) => this.detect(h)))
    return this.statuses()
  }

  /**
   * Agents were added, renamed or removed, or a program was picked: sync the slots and detect the
   * affected harnesses again. The environment already carries each agent's folder. Returns the
   * agents removed.
   */
  async settingsChanged(previous: HostSettings, next: HostSettings): Promise<AgentId[]> {
    const previousSlots = new Map(this.slots)
    const removed = this.syncAgents(next.addedAgents)
    for (const h of this.harnesses.values()) {
      const before = registeredByDefault(h.def.id, previous.agents)
      const after = registeredByDefault(h.def.id, next.agents)
      if (before && !after) removed.push(h.def.id)
      // A newly added default instance shows at once; its slot already exists for the harness.
      else if (!before && after) this.emit(this.home(h))
    }
    await Promise.all(
      removed.map(async (agentId) => {
        const slot = previousSlots.get(agentId)
        if (slot) await this.stopProcess(slot)
      }),
    )
    for (const agentId of removed) this.deps.removed?.(agentId)
    // Turning an agent off stops its process and deletes nothing.
    const turnedOff = next.disabledAgents.filter((id) => !previous.disabledAgents.includes(id))
    await Promise.all(
      turnedOff.map(async (agentId) => {
        const slot = this.slots.get(agentId)
        if (slot) await this.stopProcess(slot)
      }),
    )
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
    // Turned on again, automatic updates take the target from the version the user moved to.
    const automatic = [...this.harnesses.values()].filter(
      (h) =>
        previous.agents[h.def.id]?.autoUpdate === false &&
        next.agents[h.def.id]?.autoUpdate !== false,
    )
    for (const h of automatic) h.stay = null
    // Detecting again rewrites each idle agent's guidance in the new language.
    const changed = [...this.harnesses.values()].filter(
      (h) =>
        previous.locale !== next.locale ||
        previous.agents[h.def.id]?.binaryPath !== next.agents[h.def.id]?.binaryPath ||
        previous.agents[h.def.id]?.configDir !== next.agents[h.def.id]?.configDir ||
        previous.agents[h.def.id]?.uninstalled !== next.agents[h.def.id]?.uninstalled ||
        previous.agents[h.def.id]?.autoUpdate !== next.agents[h.def.id]?.autoUpdate,
    )
    await Promise.all(changed.map((h) => this.detect(h)))
    for (const h of automatic) void this.autoUpdate(h)
    // The manifest in force changes with whether the download service may be asked.
    if (previous.downloadService !== next.downloadService) {
      if (next.downloadService) void this.readListing()
      else void this.followTargets()
    }
    // A rename or a switch for Kettu's server shows in the status; the switch changes what a
    // start gets, and waits for the next one.
    for (const slot of this.slots.values()) this.emit(slot)
    return removed
  }

  // Lifecycle.

  runtime(agentId: AgentId): AgentRuntime | null {
    const slot = this.slots.get(agentId)
    return slot && this.has(agentId) && !this.isDisabled(agentId) && !slot.stopping
      ? slot.runtime
      : null
  }

  /** Starts the agent if needed; rejects with `agent_unavailable` when it cannot run. */
  async ensureReady(agentId: AgentId): Promise<AgentRuntime> {
    // A session keeps its agent, which may have been removed since.
    const slot = this.registeredSlot(agentId)
    this.assertEnabled(agentId)
    const { h } = slot
    await this.detectAll()
    if (slot.stopping) await slot.stopping
    if (h.installing) await h.installing.catch(() => {})
    this.registeredSlot(agentId)
    this.assertEnabled(agentId)
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
          reason: detection?.reason ?? { kind: 'not-installed' },
        },
      )
    }
    if (!detection.spec && !installsOnStart(h.def, detection.adapter)) {
      // Kettu's own copy is gone, and a start no longer installs it unasked.
      throw new HostError('agent_unavailable', t('agent.notInstalled', { agent: slot.name }), {
        agentId,
        state: 'not-installed',
        reason: { kind: 'not-installed' } satisfies HarnessReason,
      })
    }
    return this.start(slot, detection.spec)
  }

  /**
   * Launches `spec`, or installs the adapter first when it is null. A new version that does not
   * start gives way to the install that ran before it.
   */
  private async start(slot: Slot, spec: LaunchSpec | null): Promise<AgentRuntime> {
    const run = (async () => {
      const chosen = spec ?? (await this.installPackage(slot))
      slot.protocol = preferredProtocol(
        slot.def,
        this.programVersion(slot.h, chosen),
        this.programRule(slot.h),
        slot.preferredFailed,
      )
      try {
        return await this.launch(slot, chosen)
      } catch (error) {
        if (this.leavePreferred(slot, error, chosen)) return this.launch(slot, chosen)
        const previous = await this.fallBack(slot, chosen, error)
        if (!previous) throw error
        return this.launch(slot, previous)
      }
    })()
    slot.starting = run
    try {
      const runtime = await run
      this.ranVersion(slot)
      this.cleanUpVersions(slot)
      this.sessionsChanged(slot.id)
      return runtime
    } catch (error) {
      const message = (error as Error).message
      // A start the quit stopped did not fail either.
      if (error instanceof InstallCancelled || this.stopped || !this.has(slot.id)) {
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

  /**
   * The version of the program a start runs: as detection read it from the user's program, or of
   * Kettu's own install of a package, which the `spec` it launches names. Null while unknown.
   */
  private programVersion(h: Harness, spec: LaunchSpec | null = null): string | null {
    const detection = h.detection
    if (detection?.state !== 'available') return null
    const installed = h.def.launch.kind === 'package' ? (spec?.version ?? null) : null
    return detection.cli?.version ?? h.binaryVersion ?? installed
  }

  /**
   * When a start over the harness's preferred interface fails, the agent starts over its
   * definition's protocol instead, and keeps to it while its program stays that version. False
   * when the start that failed already ran on the definition's protocol.
   */
  private leavePreferred(slot: Slot, error: unknown, spec: LaunchSpec): boolean {
    if (slot.protocol === null) return false
    if (error instanceof InstallCancelled || this.stopped || !this.has(slot.id)) return false
    slot.preferredFailed = this.programVersion(slot.h, spec)
    slot.protocol = null
    this.deps.diagnostics.event(
      slot.id,
      'fall back',
      `its own interface did not start: ${(error as Error).message}`,
    )
    return true
  }

  /**
   * When a version of Kettu's own install that never ran fails to start, the install a start runs
   * without it runs instead, and that version is not taken again until the target moves on. Null
   * when no other install is there, so the start fails as any other.
   */
  private async fallBack(slot: Slot, spec: LaunchSpec, error: unknown): Promise<LaunchSpec | null> {
    const { h } = slot
    const { version } = spec
    if (error instanceof InstallCancelled || this.stopped || !this.has(slot.id)) return null
    if (!version || (h.ran !== null && compareVersions(version, h.ran) === 0)) return null
    const before = h.failed
    h.failed = { version, reason: (error as Error).message }
    await this.detect(h)
    const detection = h.detection
    const next = detection?.state === 'available' ? detection.spec : null
    if (!next?.version || compareVersions(next.version, version) === 0) {
      h.failed = before
      await this.detect(h)
      return null
    }
    this.deps.diagnostics.event(
      slot.id,
      'fall back',
      `${version} did not start; ${next.version} runs`,
    )
    return next
  }

  /**
   * Notes the version of Kettu's own install a start ran, once it answered. A version that failed
   * before is forgiven once it or a newer one runs.
   */
  private ranVersion(slot: Slot): void {
    const { h } = slot
    const version = slot.launchSpec?.version
    if (!version || version === h.ran) return
    h.ran = version
    if (h.failed && compareVersions(version, h.failed.version) >= 0) h.failed = null
    this.emit(slot)
  }

  private async launch(slot: Slot, spec: LaunchSpec): Promise<AgentRuntime> {
    const { diagnostics } = this.deps
    const agentId = slot.id
    // A program picked in Settings is asked its version in the background, and a driver that
    // goes by the version would take one not answered yet for the oldest.
    if (this.driver(slot).kind === 'hosted' && !slot.h.detection?.cli) {
      await slot.h.binaryVersionAsked
    }
    this.registeredSlot(agentId)
    this.assertEnabled(agentId)
    if (this.stopped) throw new Error(t('agent.hostStopping', { agent: slot.name }))
    slot.state = 'starting'
    slot.detail = null
    slot.progress.clear()
    slot.intentionalStop = false
    slot.launchSpec = spec
    const base = this.deps.env.agentEnv(agentId)
    const launchEnv = this.deps.launchEnv?.(agentId, base) ?? base
    const env = slot.added && slot.def.addedEnv ? { ...launchEnv, ...slot.def.addedEnv } : launchEnv
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
      this.registeredSlot(agentId)
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
      if (init.capabilities.authStatus && connection.readAuthStatus) {
        try {
          await connection.readAuthStatus()
        } catch (error) {
          diagnostics.log('warn', `${slot.name}: auth/status failed: ${(error as Error).message}`)
        }
      }
      if (slot.def.id === 'grok') {
        await this.readGrokSignIn(slot, connection, false).catch((error: unknown) => {
          diagnostics.log(
            'warn',
            `${slot.name}: its sign-in read failed: ${(error as Error).message}`,
          )
        })
      }
      await this.signInWithKey(slot, connection, init, env)
      void this.readSignInMethod(slot)
      diagnostics.event(agentId, 'ready', init.version ?? undefined)
      this.emit(slot)
      return runtime
    } catch (error) {
      slot.intentionalStop = true
      connection.close()
      const info = await launched.stop(this.tools())
      if (!launched.hasExited) this.letGo(slot, launched, info)
      throw error instanceof AgentRequestError
        ? new Error(t('agent.initializeFailed', { agent: slot.name, reason: error.message }))
        : error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  restoreConfig(
    agentId: AgentId,
    config: readonly ConfigOption[],
    legacy?: unknown,
  ): ConfigOption[] {
    return this.driver(this.slot(agentId)).restoreConfig?.(config, legacy) ?? [...config]
  }

  private driver(slot: Slot): AgentDriver {
    return driverOf(slot.def, this.deps, slot.protocol)
  }

  /**
   * A hosted agent's user CLI to start a process with: the one it started with while it is there,
   * else the one detection finds again, so a CLI replaced or moved since needs no restart and
   * stops none of the sessions that still run. Concurrent starts share one detection.
   */
  private currentCli(slot: Slot, spec: LaunchSpec): (started: string) => Promise<string> {
    let finding: Promise<string> | null = null
    return async (started) => {
      if (await isExecutableFile(started, this.deps.platform)) return started
      finding ??= this.findCliAgain(slot, spec, started).finally(() => (finding = null))
      return finding
    }
  }

  private async findCliAgain(slot: Slot, spec: LaunchSpec, gone: string): Promise<string> {
    const { h } = slot
    this.cliVersions.clear()
    await this.detect(h)
    const detection = h.detection
    let reason: string
    if (detection?.state === 'available') {
      const found = detection.spec?.cli
      // A CLI that needs another install of the SDK than the running one cannot be swapped in.
      if (found && detection.spec?.command === spec.command) {
        if (found !== gone) {
          this.deps.diagnostics.event(slot.id, 'cli moved', `${gone} is gone; ${found} runs`)
        }
        return found
      }
      reason = found
        ? t('agent.cliRestart', { agent: h.def.name, path: found })
        : t('agent.notAvailable', { agent: slot.name })
    } else {
      reason = detection?.detail ?? t('agent.notAvailable', { agent: slot.name })
    }
    throw new AgentRequestError(
      'agent_error',
      t('agent.cliGone', { agent: h.def.name, path: gone, reason }),
    )
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
      connection = driver.connect({
        ...context,
        spec,
        env,
        spawn: run.spawn,
        currentCli: this.currentCli(slot, spec),
        cliVersion: slot.h.detection?.cli?.version ?? slot.h.binaryVersion,
        kettuDir: path.join(this.deps.adaptersDir, EXTENSIONS_FOLDER, slot.def.id),
        nodeRuntime: this.deps.nodeRuntime,
        clineHostPath: this.deps.clineHostPath ?? null,
      })
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
      throw new InstallCancelled(t('agent.notInstalledStopping', { agent: h.def.name }))
    }
    const detection = h.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    if (!detection || detection.state !== 'available' || !adapter) {
      throw new Error(t('agent.noAdapter', { agent: h.def.name }))
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
      if (!adapter.npm) throw new Error(t('agent.noNpm'))
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
            ? t('agent.incompleteInstall', { name: `${adapter.package} ${version}` })
            : h.detection?.detail,
        )
      }
      return spec
    } catch (error) {
      const message = (error as Error).message
      diagnostics.event(slot.id, 'install failed', message)
      const text = withoutCli
        ? t('agent.sdkInstallFailed', { agent: h.def.name, command: h.def.cli?.command, message })
        : t('agent.installFailed', { agent: h.def.name, message })
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
   * Once the install a start picks runs, the installs before it go, but the latest of another
   * version, which a failed start falls back to. One installed after it, such as an update that
   * finished meanwhile, stays. While a process its stop gave up still runs, possibly from an older
   * install, nothing goes until the last one exits.
   */
  private cleanUpVersions(slot: Slot): void {
    const { h } = slot
    const detection = h.detection
    const { launch } = h.def
    if (detection?.state !== 'available') return
    if (detection.release?.dir) {
      this.cleanUpArchives(slot, detection.release.dir)
      return
    }
    if (launch.kind !== 'package') return
    const current = detection.adapter?.current
    if (!current || !detection.spec || slot.launchSpec !== detection.spec) return
    if (h.cleanedDir === current.dir) return
    if (this.agentsOf(h).some((agent) => this.givenUpRuns(agent))) return
    h.cleanedDir = current.dir
    const harnessId = h.def.id
    removeStaleInstalls(this.deps.adaptersDir, harnessId, launch.package, current).then(
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

  /**
   * Once the archive install a start picks runs, the installs before it go, but the latest of
   * another version. A native program may still read files of its folder while it runs, so they
   * stay while another agent of the harness runs another program, and are removed at a later start.
   */
  private cleanUpArchives(slot: Slot, dir: string): void {
    const { h } = slot
    const detection = h.detection
    if (detection?.state !== 'available' || !detection.spec) return
    if (slot.launchSpec !== detection.spec || h.cleanedDir === dir) return
    const command = detection.spec.command
    const others = this.agentsOf(h).some(
      (agent) => agent.launched && agent.launchSpec?.command !== command,
    )
    if (others || this.agentsOf(h).some((agent) => this.givenUpRuns(agent))) return
    h.cleanedDir = dir
    void (async () => {
      const keep = (await listArchiveInstalls(this.deps.adaptersDir, h.def.id)).find(
        (install) => install.dir === dir,
      )
      if (!keep) return
      const removed = await removeStaleArchives(this.deps.adaptersDir, h.def.id, keep)
      if (removed.length > 0) this.deps.diagnostics.event(slot.id, 'removed', removed.join(', '))
    })().catch((error: unknown) =>
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
   * Removes what Kettu installed for the harness, and asks the harness's own installer to remove
   * the user's program when asked. Agents and their sessions are handled by the settings change
   * that follows; external configuration and user-installed programs are never deleted here.
   */
  async uninstall(
    agentId: AgentId,
    removeProgram = false,
  ): Promise<{ command: string | null; error: string | null }> {
    const { h } = this.slot(agentId)
    await this.detectAll()
    if (h.task?.state === 'running') {
      throw invalidParams(t('agent.uninstall.busy', { agent: h.def.name }))
    }
    const program = removeProgram ? this.programUninstall(h) : null
    await this.stopAutoUpdate(h)
    for (const slot of this.agentsOf(h)) await this.stopProcess(slot)
    await rm(path.join(this.deps.adaptersDir, h.def.id), { recursive: true, force: true })
    // What the stopped processes reported belongs to the install that is gone.
    for (const slot of this.agentsOf(h)) slot.init = null
    this.deps.diagnostics.event(h.def.id, 'uninstall', 'removed what Kettu installed')
    h.latest = null
    h.skipped = null
    h.cliSkipped = null
    h.task = null
    h.detection = null
    h.installedCli = null
    h.ran = null
    h.stay = null
    h.failed = null
    h.moved = null
    if (!program) return { command: null, error: null }
    await this.deps.env.ready()
    const { platform } = this.deps
    const env = this.deps.env.agentEnv(h.def.id)
    const found = program.lookUp
      ? await findCommand(program.program, {
          platform,
          env,
          isExecutable: (file) => isExecutableFile(file, platform),
        })
      : null
    const run = await runProgram({
      program: found ?? program.program,
      args: program.args,
      cwd: os.homedir(),
      env,
      platform,
      timeoutMs: this.timings.installMs,
    })
    return {
      command: program.command,
      error: programFailure(program.command, run, this.timings.installMs),
    }
  }

  /** How to remove the user's own program, when its install route has a safe opposite. */
  private programUninstall(
    h: Harness,
  ): { command: string; program: string; args: string[]; lookUp?: boolean } | null {
    const { installs } = h.def
    if (h.def.launch.kind === 'uvx') {
      const args = ['cache', 'clean', h.def.launch.package]
      return {
        command: formatCommand({ command: 'uv', args }, this.deps.platform),
        program: 'uv',
        args,
      }
    }
    const method = h.cliMethod
    const global = h.cliGlobal
    const npmPackage = this.programPackage(h)
    if (global && npmPackage && global.manager === method) {
      const plan = uninstallPlan(global.manager, npmPackage, global.dir, this.deps.platform)
      const npm = this.deps.env.nodeProbe().npmPath
      if (!plan || (plan.tool === 'npm' && !npm)) return null
      // pnpm, bun and yarn are looked up when it runs, since `pnpm.cmd` does not start by name.
      const program = plan.tool === 'npm' ? npm! : plan.tool
      return { command: plan.command, program, args: plan.args, lookUp: plan.tool !== 'npm' }
    }
    if (!installs) return null
    if (method === 'brew') {
      const name = installs.brewCask ?? installs.brew
      if (!name) return null
      const args = installs.brewCask ? ['uninstall', '--cask', name] : ['uninstall', name]
      return {
        command: formatCommand({ command: 'brew', args }, this.deps.platform),
        program: 'brew',
        args,
      }
    }
    if (method === 'winget' && installs.winget) {
      const args = ['uninstall', installs.winget]
      return {
        command: formatCommand({ command: 'winget', args }, this.deps.platform),
        program: 'winget',
        args,
      }
    }
    return null
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
      throw invalidParams(t('detect.notInstalledByKettu', { agent: h.def.name }))
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
      await this.stopAutoUpdate(h)
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
          version: removed?.version ?? detected?.version,
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

  /** The keys the manifest's signature is checked against. */
  private get manifestKeys(): readonly string[] {
    return this.deps.manifestKeys ?? MANIFEST_KEYS
  }

  /**
   * The manifest in force: the newer of the one read from the download service and the bundled
   * one, or only the bundled one while the download service is not to be asked.
   */
  private manifest(): HarnessManifest | null {
    const read = this.deps.settings().downloadService ? this.readManifest : null
    const bundled = this.bundledManifest
    if (!read || !bundled) return read ?? bundled
    return read.sequence >= bundled.sequence ? read : bundled
  }

  /** The manifest's rule for the harness at this version of Kettu; null when it has none. */
  private rule(h: Harness): HarnessRule | null {
    return ruleFor(this.manifest(), h.def.id, this.deps.appVersion)
  }

  /**
   * The rule for the user's own program: a harness that runs it as its program, whose versions the
   * manifest names, or one whose own program runs in place of Kettu's install of it. A harness with
   * a package of Kettu's, such as Claude Code's SDK beside the user's `claude`, has the package's
   * versions there instead.
   */
  private programRule(h: Harness): HarnessRule | null {
    const detection = h.detection
    const own = detection?.state === 'available' && !!detection.release
    if (h.def.launch.kind === 'binary') return own ? null : this.rule(h)
    return this.replacesInstall(h) ? this.rule(h) : null
  }

  /** Whether the user's own program runs in place of what Kettu installs for the harness. */
  private replacesInstall(h: Harness): boolean {
    const detection = h.detection
    const { kind } = h.def.launch
    return (
      (kind === 'package' || kind === 'uvx') &&
      !h.def.cli &&
      detection?.state === 'available' &&
      !!detection.cli
    )
  }

  /**
   * The versions of the user's own program the harness runs, as an npm range, which an update of
   * it stays within: a package harness's, while that program runs in place of Kettu's install.
   * Null for any version.
   */
  private ownRange(h: Harness): string | null {
    const { launch } = h.def
    return launch.kind === 'package' && this.replacesInstall(h) ? programRange(launch) : null
  }

  /**
   * Whether Kettu's own install of the harness moves to a target version: it follows the Registry,
   * or the manifest recommends a version of it. The others keep their bundled version and their
   * vendor's updates.
   */
  private targeted(h: Harness): boolean {
    return followsRegistry(h.def) || this.target(h) !== null
  }

  /** Whether the harness moves to its target and updates by itself, as by default. */
  private automatic(h: Harness): boolean {
    return this.targeted(h) && this.deps.settings().agents[h.def.id]?.autoUpdate !== false
  }

  /** The release the harness moves to; null for one that has no target. */
  private target(h: Harness): TargetRelease | null {
    const { platform } = this.deps
    return targetRelease(h.def, this.listing, this.bundled, platform, process.arch, this.rule(h))
  }

  /**
   * Whether the user's CLI runs the SDK at `version`, for a harness whose SDK pins its CLI; null
   * while that is not known, before detection or npm's answer. True for the other harnesses, for a
   * CLI the environment names, which runs whatever its version, and for a version no newer than
   * the one that ran, since an SDK's CLI grows with it.
   */
  private cliFits(h: Harness, version: string): boolean | null {
    if (!h.def.cli?.pinsVersion) return true
    if (h.ran && compareVersions(version, h.ran) <= 0) return true
    if (!h.detection) return null
    const mine = h.detection.cli
    if (!mine?.version || mine.variable) return true
    const known = h.targetCli && sameVersion(h.targetCli.version, version) ? h.targetCli : null
    if (!known) return null
    return !known.cli || compareVersions(mine.version, known.cli) >= 0
  }

  /**
   * Which installed version a start runs: the target, with automatic updates on; with them off,
   * the version the user moved to or the one that ran last; for a harness without a target, the
   * bundled version and up. An SDK whose target needs a newer CLI than the user's runs as one
   * without a target, and keeps the one that ran while that is not known. Null for a harness
   * Kettu never installs.
   */
  private versionChoice(h: Harness): VersionChoice | null {
    const { def } = h
    if (!installsOwn(def)) return null
    const minimum = minimumOf(def)
    const rule = this.rule(h)
    const accepted = (version: string): boolean =>
      usable(rule, version) && acceptsVersion(def, this.bundled, version)
    const known = {
      ...(minimum ? { minimum } : {}),
      ...(h.failed ? { failed: h.failed.version } : {}),
      ...(h.ran ? { ran: h.ran } : {}),
      refused: (version: string) => !accepted(version),
    }
    const bundled = bundledRelease(def, this.bundled, this.deps.platform, process.arch)
    const target = this.target(h)
    const fits = target ? this.cliFits(h, target.version) : true
    if (!this.targeted(h) || fits === false) {
      return bundled ? { wanted: bundled.version, floor: true, ...known } : null
    }
    // Until the user's CLI is known to run the target, the version that ran keeps running, unless
    // the manifest withdrew it.
    const kept = fits === null && h.ran && accepted(h.ran) ? [h.ran] : []
    const stays = this.automatic(h) ? kept : [h.stay, h.ran]
    const next = fits === true ? target?.version : undefined
    const wanted = [...stays, next, bundled?.version].find(
      (version): version is string => !!version && acceptsVersion(def, this.bundled, version),
    )
    return wanted ? { wanted, ...known } : null
  }

  /** The archive a first install of the harness takes on this platform. */
  private archiveToInstall(h: Harness): { version: string; entry: ArchiveEntry } | null {
    const release =
      this.target(h) ?? bundledRelease(h.def, this.bundled, this.deps.platform, process.arch)
    return release?.kind === 'archive' ? { version: release.version, entry: release.entry } : null
  }

  /**
   * The version of Kettu's own install a start runs: a package, a release archive or a uvx
   * package; null while the user's own program runs or nothing is installed.
   */
  private ownVersion(h: Harness): string | null {
    const detection = h.detection
    if (detection?.state !== 'available') return null
    const { adapter } = detection
    if (adapter) return (adapter.current ?? adapter.fallback)?.version ?? null
    return detection.release?.version ?? null
  }

  /**
   * The update to offer. A harness with a target, with automatic updates off, is offered its
   * target whenever it differs from the version a start runs, an older one too after a
   * withdrawal. A vendor's package is offered what the last check found against the install a
   * start runs, unless the manifest says it does not work, and one that runs an install below its
   * floor, because the floor could not be installed, the floor at least.
   */
  private updateOf(h: Harness): AgentUpdate | null {
    if (this.targeted(h)) return this.targetUpdate(h)
    const detection = h.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    const running = adapter?.current ?? adapter?.fallback
    if (!adapter || !running) return null
    let offered = decideUpdate(h.latest, {
      version: running.version,
      cliVersion: h.installedCli,
    })
    // A version that failed to start, or that the manifest says does not work, is not offered.
    if (offered && h.failed && compareVersions(offered.adapterVersion, h.failed.version) === 0) {
      offered = null
    }
    if (offered && !usable(this.rule(h), offered.adapterVersion)) offered = null
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

  /**
   * The target on offer to a harness with a target and automatic updates off, or to one with them
   * on whose target is an archive without a SHA-256, which they do not install. A version that
   * failed to start, or an SDK that is not known to run on the user's CLI, is none.
   */
  private targetUpdate(h: Harness): AgentUpdate | null {
    const running = this.ownVersion(h)
    const target = this.target(h)
    if (!running || !target || compareVersions(target.version, running) === 0) return null
    if (this.automatic(h) && !unhashed(target)) return null
    if (h.failed && compareVersions(h.failed.version, target.version) === 0) return null
    if (this.cliFits(h, target.version) !== true) return null
    return { adapterVersion: target.version, cliVersion: null }
  }

  /**
   * The user's own program, as detection found it: the SDK's CLI or a binary harness's program.
   */
  private userProgram(h: Harness): { path: string; version: string | null } | null {
    const detection = h.detection
    if (detection?.cli) return { path: detection.cli.path, version: detection.cli.version }
    if (h.def.launch.kind !== 'binary' || detection?.state !== 'available' || !detection.spec) {
      return null
    }
    return { path: detection.spec.command, version: h.binaryVersion }
  }

  /**
   * The user's own program of a binary harness that detection named no CLI for: one with an npm
   * route but no `cli` of its own, such as Kilo Code's, whose updates Kettu reads from npm, or one
   * Homebrew installed, whose updates Homebrew tells, or one with a `cli` whose program was picked
   * in Settings, which runs as it is. It shows as the harness's CLI. Null while Kettu's own install
   * runs, since that one updates through the registry, or while none was found. `reported` is the
   * version the running agent named, for when the program was not asked.
   */
  private ownProgram(
    h: Harness,
    reported: string | null,
  ): { command: string; installed: InstalledCli } | null {
    const { launch, installs, cli } = h.def
    if (launch.kind !== 'binary' || this.release(h)) return null
    const checked = !!installs?.npm || this.programSource(h)?.kind === 'brew'
    if (cli ? h.detection?.cli : !checked) return null
    const mine = this.userProgram(h)
    if (!mine) return null
    const installed = {
      path: mine.path,
      version: mine.version ?? reported,
      variable: null,
      problem: null,
    }
    return { command: cli?.command ?? launch.command, installed }
  }

  /**
   * A newer version of the user's own program than the one it runs: from npm or Homebrew, or, for
   * one too old to run, at least the oldest that runs, which its own update brings before any
   * check. One whose install route tells no newer versions is offered none of them, whatever an
   * earlier check kept.
   */
  private cliUpdateVersion(h: Harness): string | null {
    const mine = this.userProgram(h)
    const problem = h.detection?.cli?.problem
    const latest = this.programSource(h) ? h.cliLatest : null
    // A newest version the manifest says does not work is not offered, nor one the harness would
    // not run, such as one an earlier check read before it kept to the range.
    if (latest && !usable(this.programRule(h), latest)) return null
    const range = this.ownRange(h)
    if (latest && range && !inNpmRange(latest, range)) return null
    if (problem?.kind === 'too-old') return latest ?? problem.minimum
    if (!latest || !mine?.version) return null
    return compareVersions(latest, mine.version) > 0 ? latest : null
  }

  /**
   * The user's own program, when the manifest says its version does not work; null when it works,
   * its version is not known, or Kettu's own install runs instead.
   */
  private versionWarning(h: Harness): AgentStatus['versionWarning'] {
    const rule = this.programRule(h)
    const version = this.userProgram(h)?.version
    if (!rule || !version || usable(rule, version)) return null
    return {
      version,
      broken: isBroken(rule, version),
      supported: rule.supported ?? null,
      recommended: rule.recommended ?? null,
    }
  }

  /**
   * What an earlier run's update check found, so an update shows without the network, and which
   * version of Kettu's own install runs.
   */
  restoreUpdates(file: AgentUpdatesFile): void {
    for (const [harnessId, entry] of Object.entries(file.agents) as [
      AgentId,
      AgentUpdatesFile['agents'][AgentId],
    ][]) {
      const h = this.harnesses.get(harnessId as HarnessId)
      if (!h || !entry) continue
      h.ran = entry.ran ?? null
      h.stay = entry.stay ?? null
      h.failed = entry.failed ?? null
      h.moved = entry.moved ?? null
      if (this.checksUpdates(h)) {
        // A harness with a target is offered it, never what npm named before.
        h.latest = this.targeted(h) ? null : entry.latest
        h.cliLatest = entry.cli ?? null
        h.checkedAt = entry.checkedAt
        h.attemptedAt = entry.attemptedAt
        h.skipped = entry.skipped ?? null
        h.cliSkipped = entry.skippedCli ?? null
      }
      h.rememberedUpdate = updateJson(h)
      this.emit(this.home(h))
    }
  }

  /** The Registry's listing as last read, so a start offline follows it. */
  restoreRegistry(file: RegistryListingFile): void {
    if (file.agents.length === 0) return
    this.listing = parseRegistry({ agents: file.agents })
    this.listingReadAt = file.readAt
  }

  /** The manifest as last read, verified again, so a start offline follows it. */
  restoreManifest(file: HarnessManifestFile): void {
    if (!file.payload) return
    const result = verifyManifest(file, 0, this.manifestKeys)
    if (!result.ok) {
      this.deps.diagnostics.log('warn', `The kept harness manifest is not used: ${result.reason}`)
      return
    }
    this.readManifest = result.manifest
    this.manifestReadAt = file.readAt
  }

  /**
   * Kettu's own package for it, the user's program, which npm or Homebrew publishes, or Kettu's
   * install of a registry release is checked. A binary harness's archive counts only while it
   * runs, since the user's own program keeps its own updates; before detection, it may.
   */
  private checksUpdates(h: Harness): boolean {
    const { launch, installs } = h.def
    if (launch.kind === 'package' || launch.kind === 'uvx') return true
    if (installs?.npm || installs?.brew || installs?.brewCask) return true
    return this.targeted(h) && (h.detection === null || !!this.release(h))
  }

  /** Kettu's install of the harness's target release that a start runs; null for the others. */
  private release(h: Harness): { version: string; dir: string | null } | null {
    const detection = h.detection
    if (!this.targeted(h) || detection?.state !== 'available') return null
    return detection.release ?? null
  }

  /**
   * Checks each harness npm publishes once its last check, found or failed, is a day old, but no
   * sooner than a minute after start. Called once the first detection is done, and again after
   * each check.
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
   * Reads the Registry's listing a minute after start, so it stays out of startup, then every
   * 6 hours.
   */
  scheduleRegistryReads(delayMs = this.timings.updateDelayMs): void {
    if (this.registryTimer || this.stopped) return
    this.registryTimer = setTimeout(() => {
      this.registryTimer = null
      void this.readListing().then(() =>
        this.scheduleRegistryReads(this.timings.registryIntervalMs),
      )
    }, delayMs)
    this.registryTimer.unref?.()
  }

  /**
   * Removes the registry's ACP server Kettu once downloaded to read Google Antigravity's plan
   * limits, with its session's record, from Kettu's own folder; agy reads them now.
   */
  async removeAntigravityUsageServer(): Promise<void> {
    const folder = path.join(this.deps.adaptersDir, 'antigravity')
    await rm(folder, { recursive: true, force: true }).catch((error: unknown) => {
      const message = (error as Error).message
      this.deps.diagnostics.log('warn', `could not remove ${folder}: ${message}`)
    })
  }

  /**
   * Keeps the plan limits current while agents are in use, since rate-limit events rarely carry
   * the used share: only agents already running with a live session, so none starts or stays up
   * for it.
   */
  startLimitReads(): void {
    if (this.limitsTimer || this.stopped) return
    this.limitsTimer = setInterval(() => {
      for (const slot of this.slots.values()) {
        if (!slot.runtime || this.hooks.liveSessions(slot.id) === 0) continue
        this.refreshLimits(slot.id).catch((error: unknown) => {
          const message = (error as Error).message
          this.deps.diagnostics.log('warn', `${slot.name}: the plan limits read failed: ${message}`)
        })
      }
    }, this.timings.limitsBackgroundMs)
    this.limitsTimer.unref?.()
  }

  /**
   * The harnesses the daily check asks about: a vendor's own package of Kettu's without a target
   * whose npm was found, and those whose user's program is installed in a way that tells its newer
   * versions. The others Kettu installs follow their target.
   */
  private checkable(): Harness[] {
    const npm = this.deps.env.nodeProbe().npmPath
    return [...this.harnesses.values()].filter((h) => {
      const detection = h.detection
      const own = h.def.launch.kind === 'package' && !this.targeted(h)
      if (own && detection?.state === 'available' && detection.adapter?.npm) return true
      const source = this.programSource(h)
      return source?.kind === 'brew' || (source?.kind === 'npm' && !!npm)
    })
  }

  /**
   * Where the user's own program's newer versions are read, by how it was installed: Homebrew for
   * a formula or cask; npm for a global install of npm, pnpm, bun or yarn, and for any other
   * program its vendor also publishes on npm, as an install script's is, at the vendor's dist-tag
   * when its install names one. Null for one whose install route tells none, such as WinGet's,
   * which gets new versions after npm does.
   */
  private programSource(
    h: Harness,
  ):
    | { kind: 'npm'; package: string; tag?: string }
    | { kind: 'brew'; name: string; cask: boolean }
    | null {
    if (!this.userProgram(h)) return null
    const installs = h.def.installs
    if (h.cliMethod === 'brew') {
      const name = installs?.brewCask ?? installs?.brew
      return name ? { kind: 'brew', name, cask: !!installs?.brewCask } : null
    }
    // WinGet gets new versions after npm does, so npm's would offer an upgrade it cannot make.
    if (h.cliMethod === 'winget') return null
    const npmPackage = h.cliGlobal ? this.programPackage(h) : (installs?.npm ?? null)
    if (!npmPackage) return null
    return {
      kind: 'npm',
      package: npmPackage,
      ...(installs?.npm === npmPackage && installs.npmTag ? { tag: installs.npmTag } : {}),
    }
  }

  private checkDue(h: Harness): number {
    return (h.attemptedAt ?? 0) + this.timings.updateIntervalMs
  }

  /**
   * The user's check (`all`) reads the Registry's listing and asks npm about every harness; the
   * daily one only asks about those due, so one whose check keeps failing waits a day like the
   * others. Never rejects, and a failure keeps the last result. A user's check during a daily one
   * runs after it.
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
      const [listing, ...results] = await Promise.all([
        all ? this.readListing(abort.signal) : null,
        ...harnesses.map((h) => this.checkHarness(h, abort.signal)),
      ])
      const failures = [...results, ...(all ? [listing] : [])].filter((r) => r !== null)
      return { checked: harnesses.length + (all ? 1 : 0), failures }
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

  private readRegistry(signal?: AbortSignal): Promise<RegistryAgents> {
    return (this.deps.fetchRegistry ?? fetchRegistry)({
      timeoutMs: this.timings.updateViewMs,
      ...(signal ? { signal } : {}),
    })
  }

  /**
   * Reads the Registry's listing and the manifest and keeps them, then moves each harness to its
   * target. Never rejects: resolves to why the Registry's read failed, in the user's terms, or
   * null; a failure keeps what was read last, and the manifest's only shows in the log.
   */
  private readListing(signal?: AbortSignal): Promise<string | null> {
    this.listingRead ??= (async () => {
      const [failure, manifest] = await Promise.all([
        this.readRegistryListing(signal),
        this.readManifestNow(signal),
      ])
      if ((failure === null || manifest) && !this.stopped) await this.followTargets()
      return failure
    })().finally(() => {
      this.listingRead = null
    })
    return this.listingRead
  }

  /** Reads the Registry's listing and keeps it; resolves to why it failed, or null. */
  private async readRegistryListing(signal?: AbortSignal): Promise<string | null> {
    let agents: RegistryAgents
    try {
      agents = await this.readRegistry(signal)
    } catch (error) {
      const message = (error as Error).message
      this.deps.diagnostics.log('warn', `The ACP Registry could not be read: ${message}`)
      return message
    }
    this.listing = agents
    this.listingReadAt = Date.now()
    this.deps.rememberRegistry?.({
      version: 1,
      readAt: this.listingReadAt,
      agents: listingEntries(agents),
    })
    return null
  }

  /**
   * Reads the manifest from the download service and keeps it, unless the service is not to be
   * asked. One whose signature does not hold, or whose sequence is older than the one in force, is
   * left. Resolves to whether the manifest changed.
   */
  private async readManifestNow(signal?: AbortSignal): Promise<boolean> {
    if (!this.deps.settings().downloadService) return false
    const { diagnostics } = this.deps
    let body: string
    try {
      body = await (this.deps.fetchManifest ?? fetchManifest)({
        timeoutMs: this.timings.updateViewMs,
        ...(signal ? { signal } : {}),
        ...(this.deps.userAgent ? { userAgent: this.deps.userAgent } : {}),
      })
    } catch (error) {
      diagnostics.log('warn', `The harness manifest could not be read: ${(error as Error).message}`)
      return false
    }
    const before = this.readManifest
    const floor = Math.max(before?.sequence ?? 0, this.bundledManifest?.sequence ?? 0)
    const result = parseManifest(body, floor, this.manifestKeys)
    if (!result.ok) {
      diagnostics.log('warn', `The harness manifest is not used: ${result.reason}`)
      return false
    }
    this.readManifest = result.manifest
    this.manifestReadAt = Date.now()
    this.deps.rememberManifest?.({ version: 1, readAt: this.manifestReadAt, ...result.signed })
    if (before?.sequence === result.manifest.sequence) return false
    diagnostics.log('info', `Harness manifest ${result.manifest.sequence} is in force`)
    return true
  }

  /** Why moving from `from` to the harness's target was right, for its page. */
  private moveReason(h: Harness, from: string): VersionMoveReason {
    if (!usable(this.rule(h), from)) return 'broken'
    return this.target(h)?.source ?? 'bundled'
  }

  /**
   * A move automatic updates made, now; `withdrawn` when it went to an older version. One that
   * finishes a withdrawal, such as installing the target after a start ran an older install in
   * its place, is told from the version withdrawn.
   */
  private movedTo(h: Harness, from: string, to: string): Move {
    const before = h.moved
    const finishes =
      !!before?.withdrawn && sameVersion(before.to, from) && compareVersions(to, before.from) < 0
    const start = finishes && before ? before.from : from
    return {
      from: start,
      to,
      at: Date.now(),
      withdrawn: compareVersions(to, start) < 0,
      reason: this.moveReason(h, start),
    }
  }

  /**
   * Notes the move the first detection made from the version that ran last, such as one a new
   * release's bundled version or the kept manifest withdrew, so its page says why it changed.
   */
  private noteStartMoves(): void {
    for (const h of this.harnesses.values()) {
      const ran = h.ran
      const now = this.ownVersion(h)
      if (!ran || !now || sameVersion(now, ran) || !this.automatic(h)) continue
      if (h.moved && sameVersion(h.moved.from, ran) && sameVersion(h.moved.to, now)) continue
      h.moved = this.movedTo(h, ran, now)
      this.emit(this.home(h))
    }
  }

  /**
   * Asks npm which CLI the target's SDK runs, for a harness whose SDK pins its CLI, once per
   * target version; a failure is tried again at the next read.
   */
  private async learnTargetCli(h: Harness, signal?: AbortSignal): Promise<void> {
    const { launch } = h.def
    const source = CLI_VERSION_SOURCES[h.def.id]
    const target = this.target(h)
    if (!h.def.cli?.pinsVersion || !source || launch.kind !== 'package') return
    if (target?.kind !== 'package') return
    if (h.targetCli && sameVersion(h.targetCli.version, target.version)) return
    const detection = h.detection
    const npm =
      (detection?.state === 'available' ? detection.adapter?.npm : null) ??
      this.deps.env.nodeProbe().npmPath
    if (!npm) return
    try {
      const found = await (this.deps.fetchLatest ?? fetchLatest)({
        npm,
        env: this.deps.env.agentEnv(h.def.id),
        platform: this.deps.platform,
        cwd: os.homedir(),
        timeoutMs: this.timings.updateViewMs,
        ...(signal ? { signal } : {}),
        package: launch.package,
        range: target.version,
        cli: source,
      })
      h.targetCli = { version: target.version, cli: found.cliVersion }
      if (found.unpackedSize) h.sizes.set(found.adapterVersion, found.unpackedSize)
    } catch (error) {
      const message = (error as Error).message
      this.deps.diagnostics.log(
        'warn',
        `${h.def.name}: the CLI ${target.version} needs was not found: ${message}`,
      )
    }
  }

  /**
   * Moves each harness Kettu installs to its target from its next start: at once when that version
   * is installed, as the one before it is after a withdrawal, else once its automatic update has
   * installed it. A version that failed to start is tried again only once the target moved on
   * from it. The others show what the manifest says of the user's own program.
   */
  private async followTargets(): Promise<void> {
    const { diagnostics, platform } = this.deps
    const following = [...this.harnesses.values()].filter((h) => installsOwn(h.def))
    await Promise.all(
      following.map(async (h) => {
        const target = this.target(h)
        if (h.failed && (!target || compareVersions(h.failed.version, target.version) !== 0)) {
          h.failed = null
        }
        const before = this.ownVersion(h)
        if (before && this.listing && followsRegistry(h.def)) {
          const listed = listedRelease(h.def, this.listing, platform, process.arch)
          if ('reason' in listed) {
            diagnostics.log(
              'info',
              `${h.def.name}: the registry's version is not used: ${listed.reason}`,
            )
          }
        }
        await this.learnTargetCli(h)
        await this.detect(h)
        const after = this.ownVersion(h)
        if (before && after && before !== after && this.automatic(h)) {
          h.moved = this.movedTo(h, before, after)
          this.emit(this.home(h))
        }
        // An install takes minutes, which a check waiting on this read does not wait for.
        void this.autoUpdate(h)
      }),
    )
    for (const slot of this.slots.values()) this.emit(slot)
  }

  /**
   * Installs the target beside the install a start runs, in the background, for a harness with a
   * target, automatic updates on and at least one agent; the next start runs it, and running
   * sessions keep theirs. An SDK waits until the user's CLI runs it. A failure leaves the current
   * install as it was, to try again at the next read.
   */
  private async autoUpdate(h: Harness): Promise<void> {
    if (this.stopped || h.autoRun || !this.automatic(h)) return
    if (!this.agentsOf(h).some((slot) => this.has(slot.id))) return
    const running = this.ownVersion(h)
    const target = this.target(h)
    if (!running || !target || compareVersions(target.version, running) === 0) return
    if (h.failed && compareVersions(h.failed.version, target.version) === 0) return
    if (this.cliFits(h, target.version) !== true) return
    const { diagnostics } = this.deps
    const note = (message: string): void => {
      if (h.autoNote === message) return
      h.autoNote = message
      diagnostics.log('info', `${h.def.name}: ${message}`)
    }
    // An update is checked against the hash the registry gives, which a first install may lack.
    if (unhashed(target)) {
      note(`${target.version} is not installed by itself: the registry gives no SHA-256 for it`)
      return
    }
    const installing = this.agentsOf(h).some((slot) => slot.state === 'installing')
    if (h.task?.state === 'running' || h.installing || h.packageInstall || installing) return
    // Installed but not run, such as one the user's CLI cannot run: installing it again would not.
    if (await this.hasInstall(h, target.version)) return
    const abort = new AbortController()
    h.autoAbort = abort
    const run = (async () => {
      diagnostics.event(h.def.id, 'auto update', `${running} to ${target.version}`)
      try {
        await this.installTarget(h, target, abort.signal, (text) =>
          diagnostics.stderr(h.def.id, text),
        )
        h.moved = this.movedTo(h, running, target.version)
        h.autoNote = null
        await this.detect(h)
      } catch (error) {
        if (abort.signal.aborted) return
        note(`the automatic update to ${target.version} failed: ${(error as Error).message}`)
      }
    })()
    h.autoRun = run
    try {
      await run
    } finally {
      h.autoRun = null
      h.autoAbort = null
      this.emit(this.home(h))
    }
  }

  /** Stops an automatic update that runs, before something else changes the harness's installs. */
  private async stopAutoUpdate(h: Harness, reason?: unknown): Promise<void> {
    h.autoAbort?.abort(reason)
    await h.autoRun
  }

  private async checkHarness(h: Harness, signal: AbortSignal): Promise<string | null> {
    const { launch } = h.def
    const { platform } = this.deps
    const detection = h.detection
    const npm =
      (detection?.state === 'available' ? detection.adapter?.npm : null) ??
      this.deps.env.nodeProbe().npmPath
    const env = this.deps.env.agentEnv(h.def.id)
    const source = this.programSource(h)
    const brew =
      source?.kind === 'brew'
        ? await findCommand('brew', {
            platform,
            env,
            isExecutable: (file) => isExecutableFile(file, platform),
          })
        : null
    const ownPackage = launch.kind === 'package' && !this.targeted(h) && !!npm
    if (!ownPackage && !(source?.kind === 'npm' && npm) && !brew) return null
    const shared = {
      env,
      platform,
      cwd: os.homedir(),
      timeoutMs: this.timings.updateViewMs,
      signal,
    }
    const fetch = this.deps.fetchLatest ?? fetchLatest
    const range = this.ownRange(h)
    const readCli = async (): Promise<string | null> => {
      if (source?.kind === 'npm' && npm) {
        const words = {
          npm,
          package: source.package,
          ...(range ? { range } : {}),
          ...(source.tag ? { tag: source.tag } : {}),
          cli: null,
        }
        return (await fetch({ ...shared, ...words })).adapterVersion
      }
      if (source?.kind === 'brew' && brew) {
        return fetchBrewLatest({
          ...shared,
          brew,
          name: source.name,
          cask: source.cask,
          ...(this.deps.runProgram ? { run: this.deps.runProgram } : {}),
        })
      }
      return null
    }
    try {
      const [latest, cli] = await Promise.all([
        launch.kind === 'package' && !this.targeted(h) && npm
          ? fetch({
              ...shared,
              npm,
              package: launch.package,
              ...(launch.updates ? { range: launch.updates } : {}),
              cli: CLI_VERSION_SOURCES[h.def.id] ?? null,
            })
          : null,
        readCli(),
      ])
      if (latest) {
        const { unpackedSize, ...update } = latest
        h.latest = update
        if (unpackedSize) h.sizes.set(update.adapterVersion, unpackedSize)
      }
      if (cli) h.cliLatest = cli
      h.checkedAt = Date.now()
      h.attemptedAt = h.checkedAt
      const found = [
        latest
          ? `${latest.adapterVersion}${latest.cliVersion ? `, CLI ${latest.cliVersion}` : ''}`
          : '',
        cli && source ? `${source.kind === 'brew' ? source.name : source.package} ${cli}` : '',
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
   * Installs the update on offer beside the install that runs now, which keeps running; a start
   * after it runs the new one. Resolves when done or cancelled; a failure leaves the old install
   * as it was.
   */
  async update(agentId: AgentId): Promise<void> {
    const { h } = this.slot(agentId)
    const { launch } = h.def
    await this.detectAll()
    if (this.targeted(h)) return this.updateToTarget(h)
    if (launch.kind !== 'package') {
      throw invalidParams(t('detect.notInstalledByKettu', { agent: h.def.name }))
    }
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

  /**
   * Moves a harness that follows the Registry, with automatic updates off, to its target: installs
   * it beside the install that runs, or takes the one already there, as the version before is
   * after a withdrawal. A start after it runs the target; a failure leaves the current one.
   */
  private async updateToTarget(h: Harness): Promise<void> {
    const agent = h.def.name
    const target = this.target(h)
    if (!target || !this.updateOf(h)) throw invalidParams(t('agent.update.none', { agent }))
    this.assertNoInstall(h)
    const chosen = async (): Promise<void> => {
      h.stay = target.version
      h.skipped = null
      await this.detect(h)
    }
    if (await this.hasInstall(h, target.version)) return chosen()
    await this.runTask(
      h,
      'update',
      this.targetCommand(h, target),
      async (signal, onOutput) => {
        await this.installTarget(h, target, signal, onOutput)
        await chosen()
      },
      (message) => t('agent.updateFailed', { agent, message }),
    )
  }

  /** Whether Kettu's own install of `version` is on disk already, such as the one kept before. */
  private async hasInstall(h: Harness, version: string): Promise<boolean> {
    const { launch, id } = h.def
    const root = this.deps.adaptersDir
    const versions =
      launch.kind === 'package'
        ? (await listInstalled(root, id, launch.package)).map((install) => install.version)
        : launch.kind === 'uvx'
          ? [h.ran, await readUvxVersion(root, id)]
          : (await listArchiveInstalls(root, id)).map((install) => install.version)
    return versions.some((found) => !!found && compareVersions(found, version) === 0)
  }

  /** What installing a target runs, as the page shows it. */
  private targetCommand(h: Harness, target: TargetRelease): string {
    switch (target.kind) {
      case 'package':
        return this.packageUpdateCommand(h, { adapterVersion: target.version, cliVersion: null })
      case 'archive':
        return target.entry.url
      case 'uvx': {
        const { launch } = h.def
        if (launch.kind !== 'uvx') return ''
        const args = uvxFetchArgs(launch.package, target.version)
        return formatCommand({ command: 'uvx', args }, this.deps.platform)
      }
    }
  }

  /**
   * Installs a target beside the install a start runs, by the harness's own route: npm for a
   * package, the archive checked by the hash the registry gives, or uv's cache for a uvx package,
   * which is recorded only once uv has fetched it. The caller detects again so a start runs it.
   */
  private async installTarget(
    h: Harness,
    target: TargetRelease,
    signal: AbortSignal,
    onOutput: (text: string) => void,
  ): Promise<void> {
    const { platform, diagnostics } = this.deps
    const { launch } = h.def
    const agent = h.def.name
    const harnessId = h.def.id
    const started = Date.now()
    const timeoutMs = this.timings.installMs
    switch (target.kind) {
      case 'package': {
        const adapter = h.detection?.state === 'available' ? h.detection.adapter : null
        if (launch.kind !== 'package' || !adapter?.npm) {
          throw new HostError(
            'agent_unavailable',
            t('detect.npmMissing', { agent, hint: t(h.def.install.hint) }),
          )
        }
        diagnostics.event(harnessId, 'update', `${launch.package}@${target.version}`)
        await (this.deps.install ?? installAdapter)({
          root: this.deps.adaptersDir,
          agentId: harnessId,
          package: launch.package,
          version: target.version,
          npm: adapter.npm,
          nodeVersion: adapter.nodeVersion,
          platform,
          env: this.deps.env.agentEnv(harnessId),
          timeoutMs,
          signal,
          onOutput,
          alongside: true,
          ...(h.def.cli ? { withoutCli: true } : {}),
        })
        break
      }
      case 'archive': {
        const { entry } = target
        diagnostics.event(harnessId, 'update', `${target.version} from ${entry.url}`)
        const installed = await (this.deps.installArchive ?? installArchive)({
          root: this.deps.adaptersDir,
          agentId: harnessId,
          version: target.version,
          url: entry.url,
          ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
          cmd: entry.cmd,
          ...(entry.args ? { args: entry.args } : {}),
          ...(entry.bare ? { bare: true as const } : {}),
          platform,
          timeoutMs,
          signal,
          onOutput,
        })
        // One whose program cannot run goes, and the version before it runs on.
        const program = programPath(installed.dir, installed.cmd, platform)
        if (!(await isExecutableFile(program, platform))) {
          await removeTree(installed.dir)
          throw new Error(t('agent.binaryInstall.incomplete', { agent }))
        }
        // As on a first install, a file the registry gives no hash for keeps the one measured.
        if (!entry.sha256) {
          diagnostics.log(
            'warn',
            `${entry.url} has no SHA-256 in the registry; installed the file with ${installed.sha256}.`,
          )
        }
        break
      }
      case 'uvx': {
        const uvx = h.detection?.state === 'available' ? h.detection.spec?.command : null
        if (!uvx || launch.kind !== 'uvx') throw invalidParams(t('agent.update.none', { agent }))
        const args = uvxFetchArgs(launch.package, target.version)
        diagnostics.event(harnessId, 'update', formatCommand({ command: 'uvx', args }, platform))
        const result = await (this.deps.runProgram ?? runProgram)({
          program: uvx,
          args,
          cwd: os.homedir(),
          env: this.deps.env.agentEnv(harnessId),
          platform,
          timeoutMs,
          signal,
          onOutput,
        })
        const problem = programFailure('uvx', result, timeoutMs)
        if (problem) throw new Error(problem)
        await writeUvxVersion(this.deps.adaptersDir, harnessId, target.version)
        break
      }
    }
    diagnostics.event(harnessId, 'updated', `${target.version} in ${Date.now() - started} ms`)
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

  /** Installs a vendor package's update beside the running install. */
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
        if (update && h.def.cli && !this.stopped && !this.targeted(h)) {
          await this.installUpdate(h, update, signal, onOutput)
        }
      },
      (message) => t('agent.updateFailed', { agent: h.def.name, message }),
      h.cliMethod,
    )
    // An SDK target that waited for a newer CLI may run on this one.
    if (this.targeted(h)) void this.autoUpdate(h)
  }

  /** The update the user's program takes, the way it was installed; null when that is unknown. */
  private async cliUpdatePlan(
    h: Harness,
  ): Promise<{ command: string; run: { program: string; args: string[] } | null } | null> {
    const mine = this.userProgram(h)
    const method = h.cliMethod
    if (!mine || !method) return null
    const installs = { ...h.def.installs }
    installs.npm ??= this.programPackage(h) ?? undefined
    const global = h.cliGlobal
    // A copy npm installed outside a global prefix, such as into a project, is not what
    // `npm install -g` updates.
    if (method === 'npm' && !global?.dir) return null
    const platform = this.deps.platform
    // Within a range, the version on offer, since the package's newest may lie outside it.
    const version = this.ownRange(h) ? this.cliUpdateVersion(h) : null
    return updatePlan(installs, method, {
      platform,
      env: this.deps.env.agentEnv(h.def.id),
      npm: this.deps.env.nodeProbe().npmPath,
      isExecutable: (file) => isExecutableFile(file, platform),
      program: mine.path,
      npmPrefix: method === 'npm' ? (global?.dir ?? null) : null,
      globalDir: method === 'pnpm' || method === 'yarn' ? (global?.dir ?? null) : null,
      ...(version ? { version } : {}),
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

  /** Offers the harness's skipped update again, as Undo in the sidebar's list does. */
  async unskipUpdate(agentId: AgentId): Promise<void> {
    const { h } = this.slot(agentId)
    if (!h.skipped && !h.cliSkipped) return
    h.skipped = null
    h.cliSkipped = null
    this.emit(this.home(h))
  }

  /**
   * Installs a harness that is missing: the user's own program by one of its routes, or a package
   * harness's pinned adapter now, without starting it. A package harness's vendor route, when one
   * is picked, installs the user's own program, which then runs in place of Kettu's. Resolves when
   * done or cancelled.
   */
  async install(agentId: AgentId, method?: AgentInstallMethod['id']): Promise<void> {
    const { h } = this.slot(agentId)
    await this.detectAll()
    // The user's program an SDK runs is installed first; one found too old is updated instead.
    const cliMissing = h.detection?.state === 'not-installed' && !h.detection.cli
    if (h.def.cli && h.def.launch.kind === 'package' && cliMissing) {
      return this.installProgram(h, method)
    }
    switch (h.def.launch.kind) {
      case 'package':
        return method && h.def.installs && !h.def.cli
          ? this.installProgram(h, method)
          : this.installNow(h)
      case 'binary':
        return this.installProgram(h, method)
      case 'uvx':
      case 'node-script':
        throw invalidParams(t('detect.notInstalledByKettu', { agent: h.def.name }))
    }
  }

  /**
   * What each way of installing the harness brings, for the install window: Kettu's own copy of
   * its npm or uvx package first, then its vendor's routes and the Registry's archive.
   */
  async installOffer(agentId: AgentId): Promise<InstallOffer> {
    const { h } = this.slot(agentId)
    await this.detectAll()
    const { def } = h
    const { launch } = def
    const { platform } = this.deps
    const node = this.deps.env.nodeProbe()
    const env = this.deps.env.agentEnv(def.id)
    // Claude Code's SDK installs on its first start, beside the user's own `claude`.
    const ownPackage = (launch.kind === 'package' && !def.cli) || launch.kind === 'uvx'
    const version = ownPackage ? (this.versionChoice(h)?.wanted ?? null) : null
    const copy = version ? { version, bytes: h.sizes.get(version) ?? null } : null
    const npmRoute = h.installPlans.some((plan) => plan.id === 'npm')
    const packages = [
      ...(copy && launch.kind === 'package' ? [launch.package] : []),
      ...(npmRoute && def.installs?.npm ? [def.installs.npm] : []),
    ]
    const [npm, uvx] = await Promise.all([
      packages.length > 0 ? this.npmConfig(h, node.npmPath, npmConfigKeys(packages), env) : null,
      launch.kind === 'uvx'
        ? findCommand('uvx', {
            platform,
            env,
            isExecutable: (file) => isExecutableFile(file, platform),
          })
        : null,
    ])
    return installOffer({
      def,
      platform,
      home: os.homedir(),
      root: this.deps.adaptersDir,
      plans: h.installPlans,
      copy,
      node,
      uv: !!uvx,
      npm,
    })
  }

  /** `npm config get` of these keys, asked once until the next redetect; null when npm fails. */
  private npmConfig(
    h: Harness,
    npm: string | null,
    keys: string[],
    env: Env,
  ): Promise<NpmConfig | null> {
    if (!npm) return Promise.resolve(null)
    const key = `${h.def.id} ${keys.join(' ')}`
    const known = this.npmConfigs.get(key)
    if (known) return known
    const read = (async () => {
      const run = await runNpm({
        npm,
        args: ['config', 'get', ...keys],
        cwd: os.homedir(),
        env,
        platform: this.deps.platform,
        timeoutMs: this.timings.updateViewMs,
      })
      const failure = programFailure('npm', run, this.timings.updateViewMs)
      if (!failure) return parseNpmConfig(run.stdout)
      this.deps.diagnostics.log(
        'warn',
        `${h.def.name}: npm's configuration was not read: ${failure}`,
      )
      this.npmConfigs.delete(key)
      return null
    })()
    this.npmConfigs.set(key, read)
    return read
  }

  /** Installs Kettu's copy of a package harness when the user asks, which a start waits for. */
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
    if (!installs) throw invalidParams(t('detect.notInstalledByKettu', { agent }))
    if (this.programRuns(h)) {
      throw invalidParams(t('agent.alreadyInstalled', { agent }))
    }
    const plan = methodId
      ? h.installPlans.find((candidate) => candidate.id === methodId)
      : h.installPlans.find((candidate) => candidate.available)
    if (!plan) {
      throw invalidParams(
        methodId
          ? t('agent.binaryInstall.methodMissing', { agent, method: methodId })
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
        if (this.programRuns(h)) return
        const folder = await installedFolder(plan, installs, {
          platform,
          home,
          npmPrefix: () => this.npmPrefix(plan.tool),
        })
        const { launch } = h.def
        const own = launch.kind === 'binary' || launch.kind === 'package' ? launch.command : null
        const command = h.def.cli?.command ?? own ?? agent
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

  /**
   * Whether detection found the harness's program to run: for a package harness, the user's own,
   * since one without it is available only to install Kettu's.
   */
  private programRuns(h: Harness): boolean {
    const detection = h.detection
    return detection?.state === 'available' && (h.def.launch.kind !== 'package' || !!detection.cli)
  }

  /** Downloads the registry's archive for the harness, then detects again so it turns available. */
  private async installArchive(h: Harness, plan: InstallPlan): Promise<void> {
    const archive = plan.archive
    if (!archive) throw invalidParams(t('agent.binaryInstall.noArchive', { agent: h.def.name }))
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
    const slot = this.registeredSlot(agentId)
    if (slot.state === 'failed') {
      slot.failures = []
      slot.state = 'available'
      slot.detail = null
      slot.preferredFailed = null
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
      if (this.hooks.liveSessions(agentId) === 0 && !slot.signInAbort) {
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
    if (this.registryTimer) clearTimeout(this.registryTimer)
    this.registryTimer = null
    if (this.limitsTimer) clearInterval(this.limitsTimer)
    this.limitsTimer = null
    for (const slot of this.slots.values()) {
      if (slot.resetsRetry) clearTimeout(slot.resetsRetry)
      slot.resetsRetry = null
    }
    this.updateAbort?.abort(QUIT_REASON)
    const slots = [...this.slots.values()]
    const harnesses = [...this.harnesses.values()]
    for (const h of harnesses) h.taskAbort?.abort(QUIT_REASON)
    const stops = Promise.all([
      this.updateCheck,
      ...harnesses.map((h) => this.stopAutoUpdate(h, QUIT_REASON)),
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
    const { diagnostics, acpMessages } = this.deps
    const agentId = slot.id
    const acp = protocolFor(slot.def, this.deps, slot.protocol) === 'acp'
    return {
      traffic: (direction, message) => {
        diagnostics.traffic(agentId, direction, message)
        if (acp) acpMessages?.add(agentId, direction, message)
        for (const run of this.processesOf(slot)) {
          if (run.pid != null) this.deps.trees?.active({ pid: run.pid, startedAt: run.startedAt })
        }
      },
      account: (account) => this.setAccount(slot, account),
      modelProviders: (providers) => {
        if (JSON.stringify(providers) === JSON.stringify(slot.modelProviders)) return
        slot.modelProviders = providers
        this.emit(slot)
      },
      signInShown: (method) => {
        slot.answeredSignIn = method
        slot.signInAnswered = true
        // No session reports Google Antigravity's limits, so a Google sign-in it shows reads them.
        if (antigravityLimitsRead(this.decideSignIn(slot)) !== 'read' || slot.limits.size > 0)
          return
        this.refreshLimits(slot.id).catch((error: unknown) => {
          const message = (error as Error).message
          this.deps.diagnostics.log('warn', `${slot.name}: the plan limits read failed: ${message}`)
        })
      },
      authState: (state) => {
        if (state === 'authenticated') slot.signIn = 'signed-in'
        else if (state === 'not_required') slot.signIn = 'signed-in'
        else if (state === 'unauthenticated') {
          slot.signIn = 'required'
          slot.account = null
        }
        this.emit(slot)
      },
      ignored: (sessionId, what) => diagnostics.ignored(agentId, sessionId, what),
      log: (level, message) => diagnostics.log(level, `${slot.name}: ${message}`),
      accountRefused: () => {
        if (slot.accountRefused) return
        slot.accountRefused = true
        this.emit(slot)
      },
    }
  }

  private setAccount(slot: Slot, account: AgentAccount): void {
    const wasRequired = slot.signIn === 'required'
    const before = slot.account
    // Grok's sign-in names no plan: the one its billing gave the same account stays.
    const named =
      account.label || before?.kind !== account.kind || before.email !== account.email
        ? account
        : { ...account, label: before.label }
    const same =
      before?.kind === named.kind && before.label === named.label && before.email === named.email
    slot.account = same && before.tier ? { ...named, tier: before.tier } : named
    // A gateway has no plan: windows kept from a sign-in before it would show as its limits.
    if (named.kind === 'gateway') slot.limits.clear()
    slot.signIn = named.kind === 'none' ? 'required' : 'signed-in'
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
    const profile = await readClaudeProfile(file, (level, message) =>
      this.deps.diagnostics.log(level, message),
    )
    // The account may have changed, or the agent been stopped and its account forgotten, meanwhile.
    if (!profile || slot.account !== account) return
    const email = account.email ?? profile.email
    // `auth status` has no plan name; the file's display name is the one Settings shows.
    const label =
      account.label === OAUTH_ACCOUNT_LABEL && profile.plan ? profile.plan : account.label
    const tier = profile.tier
    if (account.label === label && account.email === email && (account.tier ?? null) === tier)
      return
    slot.account = { kind: account.kind, label, email }
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

  /** The plan accepts requests again: a window's block is over unless the window is full. */
  allowLimits(agentId: AgentId): void {
    const slot = this.slots.get(agentId)
    if (!slot) return
    let changed = false
    for (const [window, limit] of slot.limits) {
      const allowed = allowedLimit(limit)
      if (allowed === limit) continue
      slot.limits.set(window, allowed)
      changed = true
    }
    if (changed) this.emit(slot)
  }

  /** Extra usage starts or stops covering the plan's used-up windows, as an event says. */
  setExtraUsage(agentId: AgentId, inUse: boolean): void {
    const slot = this.slots.get(agentId)
    if (!slot) return
    const before = [...slot.limits.values()]
    const now = Date.now()
    const after = inUse ? coverWithExtraUsage(before, now) : endExtraUsage(before, now)
    if (after.length === before.length && after.every((limit, i) => limit === before[i])) return
    slot.limits = new Map(after.map((limit) => [limit.window, limit]))
    this.emit(slot)
  }

  /**
   * Notes a session of the agent opening until `start` settles. Meanwhile the agent's own reads
   * wait when each session runs in a process of its own: every read starts another such process,
   * which competes with the session's start (agy's `session/new` took up to twice as long beside
   * its `/usage`).
   */
  whileOpening<T>(agentId: AgentId, start: Promise<T>): Promise<T> {
    const slot = this.slots.get(agentId)
    if (!slot) return start
    const settled = start.then(
      () => {},
      () => {},
    )
    slot.openings.add(settled)
    void settled.then(() => slot.openings.delete(settled))
    return start
  }

  /** Waits for the agent's sessions that are opening now, at most `openingWaitMs`. */
  private async afterOpenings(slot: Slot): Promise<void> {
    if (!runsPerSession(slot.def) || slot.openings.size === 0) return
    let timer: ReturnType<typeof setTimeout> | null = null
    await Promise.race([
      Promise.all(slot.openings),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.timings.openingWaitMs)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  /**
   * Reads the current use of every plan limit from the agent's report (`/usage`, `/status`), at
   * most once a minute, starting the agent if needed; the windows arrive in its status. Rate-limit
   * events report a window only when it changes, so without this most windows would stay unknown.
   */
  async refreshLimits(agentId: AgentId, options?: { force?: boolean }): Promise<void> {
    if (!this.has(agentId) || this.isDisabled(agentId)) return
    const slot = this.slot(agentId)
    if (slot.def.id === 'opencode') return this.refreshProviders(slot, options?.force === true)
    if (slot.def.id === 'deepseek') return this.refreshBalance(slot, options?.force === true)
    if (!this.hasLimits(agentId)) return
    await this.detectAll()
    const force = options?.force === true
    // A forced read is how a finished sign-in clears "required": the last failure must not stick.
    if (!slot.runtime && slot.h.detection?.state !== 'available') return
    if (!force && slot.signIn === 'required') return
    if (slot.limitsRun) return slot.limitsRun
    if (!force && Date.now() - slot.limitsReadAt < this.timings.limitsMs) return
    slot.limitsRun = this.afterOpenings(slot)
      .then(() => this.limitedRead(slot, this.readLimits(slot, force)))
      .then(
        () => this.limitsReadEnded(slot, null),
        (error: unknown) => {
          this.limitsReadEnded(slot, agentError(error).message)
          throw error
        },
      )
      .finally(() => {
        slot.limitsRun = null
      })
    return slot.limitsRun
  }

  /**
   * Keeps how the last limits read ended, so a page tells a failed read from an agent that reports
   * no limits; the limits read before stay as they were.
   */
  private limitsReadEnded(slot: Slot, error: string | null): void {
    if (slot.limitsError === error) return
    slot.limitsError = error
    this.emit(slot)
  }

  /**
   * A limits read that fails once `limitsReadMs` pass, so a read the agent never answers holds
   * the refreshes that share it only that long; a later refresh starts a read of its own.
   */
  private limitedRead(slot: Slot, read: Promise<void>): Promise<void> {
    const ms = this.timings.limitsReadMs
    let timer: ReturnType<typeof setTimeout> | null = null
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new HostError(
            'agent_error',
            t('agent.noLimits', { agent: slot.name, seconds: String(ms / 1000) }),
          ),
        )
      }, ms)
    })
    return Promise.race([read, late]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  /** Whether the agent tells its plan limits: from its connection, or from its report. */
  hasLimits(agentId: AgentId): boolean {
    const slot = this.slots.get(agentId)
    return (
      !!slot &&
      (slot.def.id === 'opencode' ||
        limitsReport(slot.def.id) !== null ||
        [
          'grok',
          'mistral-vibe',
          'copilot',
          'qoder',
          'qoder-cn',
          'kilo',
          'auggie',
          'antigravity',
        ].includes(slot.def.id) ||
        storedSignInReader(slot.def.id) !== null ||
        this.driver(slot).reads?.limits === true)
    )
  }

  /** Whether the agent tells what fills a session's context: from its connection, or its report. */
  hasContext(agentId: AgentId): boolean {
    const slot = this.slots.get(agentId)
    return !!slot && (hasContextReport(slot.def.id) || this.driver(slot).reads?.context === true)
  }

  /** The limits from the connection when it reads them, else from the agent's report. */
  private async readLimits(slot: Slot, force = false): Promise<void> {
    const stored = storedSignInReader(slot.def.id)
    if (stored) return this.readWithStoredSignIn(slot, stored)
    if (slot.def.id === 'antigravity') return this.readAntigravityLimits(slot)
    const runtime = await this.ensureReady(slot.id)
    const { connection } = runtime
    if (slot.def.id === 'grok') return this.readGrokLimits(slot, runtime, force)
    if (connection.request && slot.def.id === 'mistral-vibe') {
      const now = Date.now()
      const version = runtime.init.version ?? slot.h.binaryVersion
      if (!version || compareVersions(version, '3.1.0') < 0) return
      let hiddenSession: string | null = null
      let reply: unknown
      try {
        hiddenSession = (await connection.newSession(os.homedir(), { hidden: 'limits' })).sessionId
        reply = await connection.request<unknown>('account/read', { sessionId: hiddenSession })
      } finally {
        if (hiddenSession) await connection.closeSession(hiddenSession).catch(() => {})
      }
      const usage = parseMistralAccount(reply, now)
      if (!usage) throw this.limitsError(slot, new Error(t('agent.unknownUsageReply')))
      this.applyVendorUsage(slot, usage, now)
      return
    }
    if (['copilot', 'qoder', 'qoder-cn', 'kilo', 'auggie'].includes(slot.def.id)) {
      const version = runtime.init.version ?? slot.h.binaryVersion
      if (slot.def.id === 'copilot' && !versionAtLeast(version, '1.0.112')) return
      if (['qoder', 'qoder-cn'].includes(slot.def.id) && !versionAtLeast(version, '1.1.89')) return
      if (slot.def.id === 'auggie' && !versionAtLeast(version, '0.36.0')) return
      if (slot.def.id === 'kilo' && (!version || compareVersions(version, '7.8.28') < 0)) return
      const command = this.display(slot)
      const env = { ...this.deps.env.agentEnv(slot.id), ...command.env } as NodeJS.ProcessEnv
      const args = command.args.filter((arg) => arg !== '--acp')
      const now = Date.now()
      let usage: VendorUsage | null
      if (slot.def.id === 'copilot') {
        usage = await readCopilotQuota(command.command, [...args, '--stdio'], env, now)
      } else if (slot.def.id === 'qoder' || slot.def.id === 'qoder-cn') {
        usage = await readQoderUsage(command.command, [...args, '--sdk'], env, now)
      } else if (slot.def.id === 'kilo') {
        usage = await readKiloProfile(command.command, args, env)
      } else {
        usage = await readAuggieAccount(command.command, args, env, os.homedir(), now)
      }
      if (!usage)
        throw this.limitsError(
          slot,
          new Error(t('agent.unknownAccountReply', { agent: slot.name })),
        )
      this.applyVendorUsage(slot, usage, now)
      return
    }
    const report = limitsReport(slot.def.id)
    if (!connection.readLimits && report) {
      const version = runtime.init.version ?? slot.h.binaryVersion
      if (report.version !== undefined && !versionAtLeast(version, report.version)) return
      const read = await this.reportLimits(slot, runtime, report)
      if (read) this.applyVendorUsage(slot, read.usage, read.now)
      return
    }
    if (!connection.readLimits) return
    let limits: PlanLimit[]
    try {
      limits = await connection.readLimits()
    } catch (error) {
      throw this.limitsError(slot, error)
    }
    const now = Date.now()
    slot.limitsReadAt = now
    slot.limitsError = null
    const merged = mergeReadLimits([...slot.limits.values()], limits, now)
    slot.limits.clear()
    for (const limit of merged) slot.limits.set(limit.window, limit)
    this.emit(slot)
    // The windows do not wait for the reset credits, which arrive in a status of their own.
    if (slot.def.id === 'codex') void this.readResets(slot)
  }

  /** Where Codex keeps its ChatGPT sign-in; null for another agent or an unchecked version. */
  private codexPlace(slot: Slot): CodexPlace | null {
    if (slot.def.id !== 'codex' || slot.account?.kind !== 'account') return null
    const version = slot.init?.version ?? slot.h.binaryVersion
    const folder = this.configFolder(slot.id)
    if (!folder || !version || !versionAtLeast(version, CODEX_RESETS_VERSION)) return null
    if (!/^[\w.+-]+$/.test(version)) return null
    return {
      env: this.deps.env.agentEnv(slot.id),
      home: os.homedir(),
      platform: this.deps.platform,
      now: Date.now(),
      folder,
      version,
    }
  }

  /**
   * Reads Codex's reset credits with the windows, never twice within `RESETS_GAP_MS` however
   * often a refresh is pressed. Never rejects: what fell short is kept for the status.
   */
  private readResets(slot: Slot, retried = false): Promise<void> {
    if (slot.resetsRun) return slot.resetsRun
    if (Date.now() - slot.resetsReadAt < RESETS_GAP_MS) return Promise.resolve()
    slot.resetsRun = this.resetsRead(slot, retried).finally(() => {
      slot.resetsRun = null
    })
    return slot.resetsRun
  }

  private async resetsRead(slot: Slot, retried: boolean): Promise<void> {
    if (slot.resetsRetry) clearTimeout(slot.resetsRetry)
    slot.resetsRetry = null
    const place = this.codexPlace(slot)
    let resets = place ? slot.resets : null
    let error: ResetsError | null = null
    if (place) {
      slot.resetsReadAt = place.now
      try {
        const read = await readCodexResets(place)
        resets = read && read.resets.count > 0 ? read.resets : null
        if (read && read.details !== 'read') {
          error = read.details === 'failed' ? 'details' : read.details
        }
      } catch (failed) {
        const status = failed instanceof UsageReadError ? failed.status : undefined
        // A failed count read is told only where credits were shown, or the sign-in ran out.
        error = status === 401 ? 'sign-in-expired' : resets ? 'failed' : null
        const message = failed instanceof Error ? failed.message : String(failed)
        this.deps.diagnostics.log('warn', `${slot.name}: the reset credits read failed: ${message}`)
      }
    }
    // The expiries are tried again sooner than the next regular read, once.
    if (!retried && !this.stopped && (error === 'details' || error === 'failed')) {
      slot.resetsRetry = setTimeout(() => {
        slot.resetsRetry = null
        void this.readResets(slot, true)
      }, RESETS_RETRY_MS)
      slot.resetsRetry.unref?.()
    }
    if (JSON.stringify(slot.resets) === JSON.stringify(resets) && slot.resetsError === error) {
      return
    }
    slot.resets = resets
    slot.resetsError = error
    this.emit(slot)
  }

  /**
   * Spends one of Codex's reset credits, which cannot be undone, then reads the windows and the
   * credits again: both changed with it, so neither is edited here.
   */
  async spendReset(
    agentId: AgentId,
    creditId: string,
    requestId: string,
  ): Promise<{ code: ResetSpendCode }> {
    const slot = this.registeredSlot(agentId)
    const place = this.codexPlace(slot)
    if (!place) throw new HostError('agent_error', t('agent.noResets', { agent: slot.name }))
    let code: ResetSpendCode
    try {
      code = await spendCodexReset(place, creditId, requestId)
    } catch (error) {
      if (error instanceof UsageReadError && error.status === 401) {
        throw new HostError('agent_error', t('agent.resetSignInExpired', { agent: slot.name }))
      }
      throw agentError(error)
    }
    await slot.resetsRun?.catch(() => {})
    slot.resetsReadAt = 0
    await this.refreshLimits(agentId, { force: true }).catch(() => {})
    await this.readResets(slot)
    return { code }
  }

  /**
   * Reads the plan limits with the sign-in the harness keeps, which needs no agent running, at the
   * version a start runs: the running one's, else the installed package's or program's.
   */
  private async readWithStoredSignIn(slot: Slot, reader: StoredSignInReader): Promise<void> {
    const detection = slot.h.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    const version =
      slot.init?.version ??
      (adapter
        ? (adapter.current?.version ?? adapter.version)
        : (detection?.cli?.version ?? slot.h.binaryVersion))
    if (!readerOpen(reader, version)) return
    // A signed-out Cursor is told by its CLI, before any sign-in of its own is looked for.
    if (
      slot.def.id === 'cursor' &&
      (await this.readCursorSignIn(slot))?.state === 'unauthenticated'
    )
      return
    const now = Date.now()
    let usage: VendorUsage
    try {
      usage = await reader.read({
        env: this.deps.env.agentEnv(slot.id),
        home: os.homedir(),
        platform: this.deps.platform,
        now,
        ...(slot.def.id === 'cursor'
          ? {
              renew: async () => {
                await this.runCursorCli(slot, ['status'])
              },
            }
          : {}),
      })
    } catch (error) {
      if (error instanceof KeychainRefused) {
        throw new HostError('agent_error', t('agent.keychainRefused', { agent: slot.name }))
      }
      throw this.limitsError(slot, error)
    }
    this.applyVendorUsage(slot, usage, now)
  }

  /** Runs the user's Cursor CLI with `args` in place of `acp`, with the agent's environment. */
  private async runCursorCli(slot: Slot, args: string[]): Promise<ProgramRun> {
    const command = this.display(slot)
    return runProgram({
      program: command.command,
      args: [...command.args.filter((arg) => arg !== 'acp'), ...args],
      cwd: os.homedir(),
      env: { ...this.deps.env.agentEnv(slot.id), ...command.env },
      platform: this.deps.platform,
      timeoutMs: 20_000,
    })
  }

  /** Cursor's sign-in, account and plan from its CLI's `about`; null when that cannot be read. */
  private async readCursorSignIn(slot: Slot): Promise<CursorSignIn | null> {
    const run = await this.runCursorCli(slot, ['about', '--format', 'json'])
    const signIn = parseCursorAbout({
      code: run.code,
      stdout: run.stdout,
      stderr: run.output.toString(),
    })
    if (!signIn) this.deps.diagnostics.ignored(slot.id, null, 'about with an unknown answer')
    else if (signIn.account) this.setAccount(slot, signIn.account)
    else this.signedOut(slot)
    return signIn
  }

  /**
   * Google Antigravity's quota groups and G1 credits, from the user's `agy`, which needs no agy
   * process running: only on a Google or Gemini Enterprise sign-in, since a signed-out agy answers
   * by opening a browser to sign in. A sign-in Kettu does not know yet it asks agy for first.
   */
  private async readAntigravityLimits(slot: Slot): Promise<void> {
    let method = await this.readSignInMethod(slot)
    if ((method === null && !slot.signInAnswered) || slot.signIn === 'required') {
      method = await this.askAntigravitySignIn(slot)
    }
    const read = antigravityLimitsRead(method)
    if (read === 'none') return
    if (read === 'unknown') {
      throw new HostError('agent_error', t('agent.antigravityNoPlan', { agent: slot.name }))
    }
    const version = slot.init?.version ?? slot.h.binaryVersion
    if (!versionAtLeast(version, ANTIGRAVITY_USAGE_VERSION)) return
    const command = this.display(slot)
    const base = this.deps.env.agentEnv(slot.id)
    const env = { ...(this.deps.launchEnv?.(slot.id, base) ?? base), ...command.env }
    await mkdir(this.deps.reportsDir, { recursive: true })
    const now = Date.now()
    let usage: VendorUsage
    try {
      usage = await readAntigravityUsage(
        {
          name: slot.name,
          program: command.command,
          args: command.args.filter((arg) => arg !== 'acp'),
          env,
          cwd: this.deps.reportsDir,
          platform: this.deps.platform,
          timeoutMs: 30_000,
        },
        now,
      )
    } catch (error) {
      throw this.limitsError(slot, error)
    }
    this.applyVendorUsage(slot, usage, now)
  }

  /**
   * Asks agy how it is signed in, never signing it in: its answer to a hidden session names its
   * plan when signed in with Google, and refuses the session when signed out.
   */
  private async askAntigravitySignIn(slot: Slot): Promise<string | null> {
    const runtime = await this.ensureReady(slot.id)
    if (!runtime.connection.unpromptedSessions) return slot.signInMethod
    const log = (message: string): void =>
      this.deps.diagnostics.log('warn', `${slot.name}: ${message}`)
    try {
      if (await this.readInHiddenSession(slot, runtime, log, undefined)) this.signedIn(slot.id)
    } catch (error) {
      throw this.limitsError(slot, error)
    }
    if (slot.signIn === 'required') {
      throw new HostError('auth_required', t('agent.antigravitySignedOut', { agent: slot.name }))
    }
    return slot.signInMethod
  }

  /**
   * The method a `sharesSignIn` agent is signed in with, its own files read again; it may have
   * changed outside Kettu, in its terminal sign-in or its app.
   */
  private async readSignInMethod(slot: Slot): Promise<string | null> {
    if (slot.def.id !== 'antigravity') return null
    const text = await readFile(antigravityAuthStateFile(os.homedir()), 'utf8').catch(() => '')
    slot.signInFile = antigravitySignInMethod(text)
    return this.decideSignIn(slot)
  }

  /**
   * Google Antigravity's sign-in from what agy showed and the key Kettu holds for it: agy writes
   * its auth state file only when an ACP client calls `authenticate`, so a sign-in in its app or
   * terminal leaves none.
   */
  private decideSignIn(slot: Slot): string | null {
    const key = slot.def.keySignIn
    const method = antigravitySignIn({
      answered: slot.answeredSignIn,
      file: slot.signInFile,
      key: !!key && this.deps.envKeyIsSet?.(slot.id, key.variable) === true,
    })
    if (method !== slot.signInMethod) {
      slot.signInMethod = method
      this.emit(slot)
    }
    return method
  }

  /**
   * Grok's sign-in from its own `x.ai/auth/info`, which answers without signing in. A running Grok
   * never sees a sign-in made in a terminal, so `reload` has it load the cached token first; null
   * when the reply cannot be read.
   */
  private async readGrokSignIn(
    slot: Slot,
    connection: AgentConnection,
    reload: boolean,
  ): Promise<GrokSignIn | null> {
    const request = connection.request?.bind(connection)
    if (!request || !versionAtLeast(runningVersion(slot), GROK_READS_VERSION)) return null
    const ask = async () => parseGrokAuthInfo(await request<unknown>('_x.ai/auth/info', {}))
    let signIn = await ask()
    if (reload && signIn?.state === 'unauthenticated') {
      // Without a cached token it ends within seconds and opens no browser (1.0.88).
      await connection.authenticate(GROK_CACHED_SIGN_IN).catch(() => {})
      signIn = await ask()
    }
    if (!signIn)
      this.deps.diagnostics.ignored(slot.id, null, 'x.ai/auth/info with an unknown shape')
    else if (signIn.account) this.setAccount(slot, signIn.account)
    else this.signedOut(slot)
    return signIn
  }

  /** Grok's plan from `x.ai/billing`, read only while it is signed in. */
  private async readGrokLimits(slot: Slot, runtime: AgentRuntime, force: boolean): Promise<void> {
    const { connection } = runtime
    if (!connection.request || !versionAtLeast(runningVersion(slot), GROK_READS_VERSION)) return
    const signIn = await this.readGrokSignIn(slot, connection, force)
    if (signIn?.state === 'unauthenticated') return
    const now = Date.now()
    let reply: unknown
    try {
      reply = await connection.request<unknown>('_x.ai/billing', {})
    } catch (error) {
      if (error instanceof AgentRequestError && error.kind === 'auth_required') {
        this.signedOut(slot)
        return
      }
      throw error
    }
    const usage = parseGrokBilling(reply, now)
    if (!usage) throw this.limitsError(slot, new Error(t('agent.unknownUsageReply')))
    this.applyVendorUsage(slot, usage, now)
    if (slot.signIn !== 'signed-in') this.signedIn(slot.id)
  }

  /** The agent says it is signed out: its account and the plan it read are gone. */
  private signedOut(slot: Slot): void {
    slot.signIn = 'required'
    slot.account = null
    slot.limits.clear()
    slot.balances = []
    slot.resets = null
    slot.resetsError = null
    this.emit(slot)
  }

  private applyVendorUsage(slot: Slot, usage: VendorUsage, now: number): void {
    slot.balances = usage.balances
    if (usage.tier) {
      slot.account = slot.account
        ? { ...slot.account, label: usage.tier }
        : { kind: 'account', label: usage.tier, email: null }
    }
    slot.limitsReadAt = now
    slot.limitsError = null
    slot.limits = new Map(
      mergeReadLimits([...slot.limits.values()], usage.limits, now).map((item) => [
        item.window,
        item,
      ]),
    )
    this.emit(slot)
  }

  /**
   * Runs the agent's report in a hidden session; null when the agent cannot run one. A report
   * Kettu cannot read is a failed read, whose error never quotes the agent's reply.
   */
  private async reportLimits(
    slot: Slot,
    runtime: AgentRuntime,
    report: LimitsReport,
  ): Promise<{ usage: VendorUsage; now: number } | null> {
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
    const usage = messages
      .map((text) => report.parse(text, now))
      .findLast((parsed) => parsed !== null)
    if (usage) return { usage, now }
    // No hidden session ran the report, which `runReport` logged.
    if (!runtime.connection.hiddenSessions) return null
    log(`${slot.name}: ${report.command} gave no report Kettu can read`)
    throw new HostError(
      'agent_error',
      t('agent.unreadableLimits', { agent: slot.name, command: report.command }),
    )
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
    slot.optionsRun ??= this.openForOptions(slot, folder)
      .then(() => {})
      .finally(() => {
        slot.optionsRun = null
      })
    return slot.optionsRun
  }

  /**
   * The config options a hidden session in `folder` reports now, starting the agent when it is
   * not running. Null when it reads none unprompted, must sign in, answered nothing in time or
   * failed; a failure is logged.
   */
  async readConfig(agentId: AgentId, folder: string): Promise<ConfigOption[] | null> {
    if (this.isDisabled(agentId)) return null
    const slot = this.slot(agentId)
    await slot.optionsRun?.catch(() => {})
    return this.openForOptions(slot, folder, true)
  }

  private async openForOptions(
    slot: Slot,
    folder: string | undefined,
    start = false,
  ): Promise<ConfigOption[] | null> {
    const agentId = slot.id
    const log = (message: string): void =>
      this.deps.diagnostics.log('warn', `${slot.name}: ${message}`)
    await this.afterOpenings(slot)
    // A limits report running meanwhile reads them too.
    await slot.limitsRun?.catch(() => {})
    if (slot.signIn === 'required') return null
    try {
      const runtime = start ? await this.ensureReady(agentId) : this.runtime(agentId)
      if (!runtime?.connection.unpromptedSessions) return null
      return await this.readInHiddenSession(slot, runtime, log, folder)
    } catch (error) {
      if (error instanceof AgentRequestError && error.kind === 'auth_required') {
        this.authRequired(agentId)
        return null
      }
      log(`could not read its options: ${agentError(error).message}`)
      return null
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
    if (this.isDisabled(agentId)) return
    const slot = this.slot(agentId)
    const runtime = await this.ensureReady(agentId)
    await this.afterOpenings(slot)
    await slot.limitsRun?.catch(() => {})
    if (slot.signIn === 'required' || !runtime.connection.unpromptedSessions) return
    const log = (message: string): void =>
      this.deps.diagnostics.log('warn', `${slot.name}: ${message}`)
    let read: ConfigOption[] | null
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
   * `session/new` in the folder, bounded by `optionsMs`, then the session's removal. The options
   * it answered with, or null when no answer came in time.
   */
  private async readInHiddenSession(
    slot: Slot,
    runtime: AgentRuntime,
    log: (message: string) => void,
    folder: string | undefined,
  ): Promise<ConfigOption[] | null> {
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
      return null
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
    return setup.config
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
          ? (inUse ??
            (adapter ? path.join(this.deps.adaptersDir, harnessId, adapter.version) : null))
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
      // A window an earlier run kept under one of Claude Code's other names is read again.
      const kept = entry.limits.filter((limit) => planWindow(limit.window) === limit.window)
      slot.limits = new Map(kept.map((limit) => [limit.window, limit]))
      slot.initRecord = entry.init ?? null
      slot.apiKey = entry.apiKey === true
      slot.answeredSignIn = entry.signIn ?? null
      slot.remembered = rememberedJson(slot)
      if (slot.def.id === 'antigravity') this.decideSignIn(slot)
      this.emit(slot)
    }
  }

  /**
   * Brings an agent's account and plan limits up to date for Settings › Agents, starting an agent
   * that reports them. Never installs: an agent that would need an install first is left alone.
   */
  async refreshAccount(agentId: AgentId, options?: { force?: boolean }): Promise<void> {
    const slot = this.registeredSlot(agentId)
    if (this.isDisabled(agentId)) return
    if (slot.def.id === 'opencode') return this.refreshProviders(slot, options?.force === true)
    if (slot.def.id === 'deepseek') {
      // A model route set up in dsh's own pages tells Kettu nothing.
      if (options?.force === true && slot.signIn === 'required') await this.checkSignIn(slot)
      return this.refreshBalance(slot, options?.force === true)
    }
    const force = options?.force === true
    if (!slot.def.reportsAccount) {
      if (force && slot.signIn === 'required') await this.checkSignIn(slot)
      else if (slot.def.id === 'pi' && slot.modelProviders === null)
        await this.readModelProviders(slot)
      return
    }
    await this.detectAll()
    if (!force && slot.signIn === 'required') return
    if (!slot.runtime && (slot.h.detection?.state !== 'available' || !slot.h.detection.spec)) return
    try {
      if (this.hasLimits(agentId)) await this.refreshLimits(agentId, { force })
      else await this.ensureReady(agentId)
    } catch (error) {
      // Still signed out: the notice stays, and opening the page is not an error.
      if (force && error instanceof HostError && error.code === 'auth_required') return
      throw error
    }
  }

  /**
   * Pi names no account, only the providers its models come from, which it lists when a session
   * starts: before any did, a hidden session reads them, once for all who ask meanwhile.
   */
  private async readModelProviders(slot: Slot): Promise<void> {
    await this.detectAll()
    if (!slot.runtime && (slot.h.detection?.state !== 'available' || !slot.h.detection.spec)) return
    if (slot.providersRun) return slot.providersRun
    slot.providersRun = this.readFirstOptions(slot.id).finally(() => {
      slot.providersRun = null
    })
    return slot.providersRun
  }

  /**
   * Asks a signed-out agent that reports no account whether it still is, in a hidden session: a
   * sign-in made in its terminal or files, such as Pi's providers, tells Kettu nothing otherwise.
   */
  private async checkSignIn(slot: Slot): Promise<void> {
    await this.detectAll()
    if (!slot.runtime && (slot.h.detection?.state !== 'available' || !slot.h.detection.spec)) return
    await slot.optionsRun?.catch(() => {})
    const log = (message: string): void =>
      this.deps.diagnostics.log('warn', `${slot.name}: ${message}`)
    try {
      const runtime = await this.ensureReady(slot.id)
      if (!runtime.connection.unpromptedSessions) return
      await this.readInHiddenSession(slot, runtime, log, undefined)
    } catch (error) {
      // Still signed out: the notice stays, and opening the page is not an error.
      if (error instanceof AgentRequestError && error.kind === 'auth_required') return
      if (error instanceof HostError && error.code === 'auth_required') return
      throw agentError(error)
    }
    if (slot.signIn === 'signed-in') this.hooks.signedIn(slot.id)
  }

  /**
   * What reads an OpenCode agent's stored sessions; null for another agent. The server that runs
   * its sessions reads them while it runs, else OpenCode's own client does.
   */
  openCode(agentId: AgentId): OpenCodeSessions | null {
    const slot = this.slots.get(agentId)
    if (!slot || harnessOf(agentId) !== 'opencode') return null
    const connection = slot.stopping ? null : slot.runtime?.connection
    return connection instanceof OpenCodeConnection && !connection.isClosed
      ? connection.stored
      : this.openCodeClient(slot)
  }

  private openCodeClient(slot: Slot): OpenCodeClient {
    const display = this.display(slot)
    return new OpenCodeClient({
      program: display.command,
      env: this.deps.env.agentEnv(slot.id),
      platform: this.deps.platform,
      ...(this.deps.runProgram ? { runProgram: this.deps.runProgram } : {}),
    })
  }

  private async refreshProviders(slot: Slot, force: boolean): Promise<void> {
    await this.detectAll()
    if (slot.h.detection?.state !== 'available' || !slot.h.detection.spec) return
    if (slot.providersRun) return slot.providersRun
    if (!force && Date.now() - slot.providersReadAt < this.timings.limitsMs) return
    slot.providersRun = this.limitedRead(slot, this.readProviders(slot)).finally(() => {
      slot.providersRun = null
    })
    return slot.providersRun
  }

  private async readProviders(slot: Slot): Promise<void> {
    try {
      const display = this.display(slot)
      const providers = (await this.openCodeClient(slot).providers()).map((provider) => {
        const previous = slot.providers.find((p) => p.id === provider.id)
        const sameAccounts =
          previous && JSON.stringify(previous.accounts) === JSON.stringify(provider.accounts)
        if (provider.usage?.state === 'error' && previous?.usage && sameAccounts) {
          return {
            ...provider,
            usage: {
              ...provider.usage,
              limits: previous.usage.limits,
              balances: previous.usage.balances,
              observedAt: previous.usage.observedAt,
            },
          }
        }
        return provider
      })
      slot.providers = providers.map((provider) => ({
        ...provider,
        loginCommand: formatCommand(
          {
            command: display.command,
            args: ['auth', 'login', provider.id],
            env: display.env,
          },
          this.deps.platform,
        ),
      }))
      slot.providersError = null
      slot.providersReadAt = Date.now()
      slot.limits.clear()
      for (const provider of providers) {
        for (const limit of provider.usage?.limits ?? []) {
          const window = `${provider.id}:${limit.window}`
          slot.limits.set(window, { ...limit, window, label: `${provider.name} · ${limit.label}` })
        }
      }
      const connected = providers.filter((provider) => provider.accounts.some((a) => !a.needsAuth))
      slot.account =
        connected.length > 0
          ? { kind: 'external', label: connected.map((p) => p.name).join(', '), email: null }
          : null
      const wasRequired = slot.signIn === 'required'
      // Free and local models work without a connected account.
      slot.signIn = connected.length > 0 ? 'signed-in' : 'unknown'
      if (wasRequired && connected.length > 0) this.hooks.signedIn(slot.id)
    } catch {
      slot.providersError = t('agent.providersFailed')
      throw new HostError('agent_unavailable', slot.providersError)
    } finally {
      this.emit(slot)
    }
  }

  private async refreshBalance(slot: Slot, force: boolean): Promise<void> {
    if (slot.balanceRun) return slot.balanceRun
    if (!force && Date.now() - slot.balanceReadAt < this.timings.limitsMs) return
    slot.balanceRun = this.limitedRead(slot, this.readBalance(slot)).finally(() => {
      slot.balanceRun = null
    })
    return slot.balanceRun
  }

  /**
   * Asks DeepSeek for the balance of the sign-in the agent's dsh home holds: an API key's at its
   * API, an account's at its platform. The credential is read for this one request and never kept.
   * The route is read again here too, since dsh tells Kettu nothing when the user signs in in its
   * own page or a terminal.
   */
  private async readBalance(slot: Slot): Promise<void> {
    await this.detectAll()
    const env = { ...this.deps.env.agentEnv(slot.id), DSH_HOME: this.dshFolder(slot) }
    const route = await readDshProvider(env)
    // A route that is gone is left to the next session: only dsh's model list tells whether
    // another one still works.
    if (route && slot.account?.kind !== routeAccount(route).kind) {
      this.setAccount(slot, routeAccount(route))
    }
    const now = Date.now()
    let read: AccountBalance | null = null
    if (route === 'deepseek-official') {
      const key = await readDshKey(env)
      if (key) {
        read = {
          usage: await readProviderUsage({ providerId: 'deepseek', key, now }),
          expired: false,
        }
      }
    } else if (route === 'deepseek-account') {
      const token = await readDshAccountToken(env)
      if (token) read = await readAccountBalance({ token, now })
    }
    const previous = slot.balanceRoute === route ? slot.balance : null
    // A failed read keeps the last balance of the same route, marked as old by its time; an
    // expired sign-in keeps none, since only signing in again shows it.
    slot.balance =
      read?.usage.state === 'error' && !read.expired && previous && previous.balances.length > 0
        ? { ...read.usage, balances: previous.balances, observedAt: previous.observedAt }
        : (read?.usage ?? null)
    slot.balanceRoute = route
    slot.balanceReadAt = now
    this.emit(slot)
  }

  async providerAction(input: AgentProviderAction): Promise<void> {
    const slot = this.registeredSlot(input.agentId)
    if (slot.def.id !== 'opencode') throw invalidParams(t('agent.noProviders'))
    if (slot.providerActionRun) throw new HostError('busy', t('agent.providerBusy'))
    const run = async (): Promise<void> => {
      await this.detectAll()
      const detection = slot.h.detection
      if (detection?.state !== 'available' || !detection.spec) {
        throw new HostError(
          'agent_unavailable',
          detection && detection.state !== 'available'
            ? detection.detail
            : t('agent.notAvailable', { agent: slot.def.name }),
        )
      }
      await slot.providersRun
      await this.openCodeClient(slot).action(input)
      await this.credentialsChanged(slot)
      await this.refreshProviders(slot, true)
    }
    slot.providerActionRun = run().finally(() => {
      slot.providerActionRun = null
    })
    return slot.providerActionRun
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
    if (!slot || (slot.signIn === 'signed-in' && !slot.accountRefused)) return
    slot.signIn = 'signed-in'
    slot.accountRefused = false
    this.emit(slot)
  }

  /**
   * Runs one of the agent's own sign-in methods for the client that asked, where a page the agent
   * hands over opens. A paired device may not start one that opens a browser on this computer
   * instead, which nobody there may see. A new sign-in stops one still in progress.
   */
  async authenticate(
    agentId: AgentId,
    methodId: string,
    client: { device: boolean; openLink(url: string): void },
  ): Promise<void> {
    const runtime = await this.ensureReady(agentId)
    const method = runtime.init.authMethods.find((m) => m.id === methodId)
    if (!method) {
      throw invalidParams(
        t('agent.noSignInMethod', { agent: this.name(agentId), method: methodId }),
      )
    }
    if (method.type === 'env') {
      throw invalidParams(
        t('agent.keyInSettings', { method: method.name, agent: this.name(agentId) }),
      )
    }
    if (method.type !== 'agent') {
      throw invalidParams(t('agent.signInInTerminal', { method: method.name }))
    }
    const slot = this.slot(agentId)
    if (client.device && !handsOverPage(slot.def, methodId)) {
      throw new HostError('forbidden', t('agent.signInOnComputer', { agent: slot.name }))
    }
    slot.signInAbort?.abort()
    const abort = new AbortController()
    slot.signInAbort = abort
    try {
      await runtime.connection.authenticate(methodId, {
        openLink: client.openLink,
        signal: abort.signal,
      })
    } catch (error) {
      if (abort.signal.aborted) {
        throw new HostError('agent_error', t('agent.signInCancelled', { agent: slot.name }))
      }
      throw agentError(error)
    } finally {
      if (slot.signInAbort === abort) {
        slot.signInAbort = null
        this.sessionsChanged(agentId)
      }
    }
    slot.signIn = 'signed-in'
    slot.accountRefused = false
    this.emit(slot)
    this.hooks.signedIn(agentId)
    void this.readSignInMethod(slot)
  }

  /** Stops the agent's sign-in in progress, whose `authenticate` then rejects. */
  cancelSignIn(agentId: AgentId): void {
    this.slots.get(agentId)?.signInAbort?.abort()
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
    slot.answeredSignIn = null
    this.emit(slot)
    void this.readSignInMethod(slot)
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
      this.deps.nodeRuntime,
      override,
      this.deps.adaptersDir,
      this.deps.sessionRouterPath ?? null,
      this.versionChoice(slot.h)?.wanted ?? null,
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
   * Hands the harness an API key for this agent to keep: Claude Code's and Codebuddy Code's in
   * their folder's settings.json, Codex's through `codex login --with-api-key`, DeepSeek
   * Harness's in its `.credentials.yaml`. A process that runs keeps its
   * credentials until it stops, so an idle one is stopped and the next start uses the key.
   */
  async setApiKey(agentId: AgentId, input: ApiKeyInput): Promise<void> {
    const slot = this.registeredSlot(agentId)
    await this.detectAll()
    const checked = checkApiKey(input, slot.def.id === 'claude-code')
    if (slot.def.id === 'claude-code') {
      await writeClaudeKey(this.settingsFile(slot), checked)
    } else if (slot.def.id === 'codex') {
      await this.runCodexLogin(slot, ['login', '--with-api-key'], checked.key)
    } else if (slot.def.id === 'deepseek') {
      await writeDshKey(this.dshFolder(slot), checked.key)
    } else if (slot.def.id === 'codebuddy') {
      await writeCodebuddyKey(this.settingsFile(slot), checked)
    } else {
      throw invalidParams(t('agent.noApiKey', { agent: slot.def.name }))
    }
    this.deps.diagnostics.event(agentId, 'api key', 'set')
    slot.apiKey = true
    await this.credentialsChanged(slot)
  }

  /** Removes what `setApiKey` handed over: the variables it wrote, or Codex's login. */
  async clearApiKey(agentId: AgentId): Promise<void> {
    const slot = this.registeredSlot(agentId)
    await this.detectAll()
    if (slot.def.id === 'claude-code') await clearClaudeKey(this.settingsFile(slot))
    else if (slot.def.id === 'codex') await this.runCodexLogin(slot, ['logout'])
    else if (slot.def.id === 'deepseek') await clearDshKey(this.dshFolder(slot))
    else if (slot.def.id === 'codebuddy') await clearCodebuddyKey(this.settingsFile(slot))
    else throw invalidParams(t('agent.noApiKey', { agent: slot.def.name }))
    this.deps.diagnostics.event(agentId, 'api key', 'cleared')
    slot.apiKey = false
    await this.credentialsChanged(slot)
  }

  async agentEnvChanged(agentId: AgentId): Promise<void> {
    const slot = this.registeredSlot(agentId)
    const key = slot.def.keySignIn
    slot.keySignInPending =
      key !== undefined && this.deps.envKeyIsSet?.(agentId, key.variable) === true
    // The next start signs in with the key, so a Google plan shown before no longer holds.
    if (slot.keySignInPending) slot.answeredSignIn = null
    if (slot.def.id === 'antigravity') this.decideSignIn(slot)
    await this.credentialsChanged(slot)
  }

  /**
   * Signs in with the key Kettu keeps once it changed: the agent reads it from its environment
   * only when asked to sign in with it. A failure is logged and leaves the sign-in to the user.
   */
  private async signInWithKey(
    slot: Slot,
    connection: AgentConnection,
    init: AgentInit,
    env: Env,
  ): Promise<void> {
    const key = slot.def.keySignIn
    if (!key || !slot.keySignInPending) return
    if (!getEnv(env, key.variable, this.deps.platform)) return
    if (!init.authMethods.some((method) => method.id === key.method)) return
    slot.keySignInPending = false
    try {
      await connection.authenticate(key.method, {
        openLink: () => {},
        signal: AbortSignal.timeout(this.timings.initializeMs),
      })
      slot.signIn = 'signed-in'
    } catch (error) {
      this.deps.diagnostics.log(
        'warn',
        `${slot.name}: signing in with its key failed: ${(error as Error).message}`,
      )
    }
  }

  // Claude Code's common settings.

  /** A Claude Code agent's auto-compact windows and prompt cache duration, from its settings file. */
  async claudeSettings(agentId: AgentId, listed: readonly ListedModel[]): Promise<ClaudeSettings> {
    const slot = this.claudeSlot(agentId)
    await this.detectAll()
    return readClaudeSettings(this.settingsFile(slot), listed)
  }

  /** Writes one of them into the settings file; a session opened later reads it. */
  async setClaudeSetting(agentId: AgentId, change: ClaudeSettingChange): Promise<void> {
    const slot = this.claudeSlot(agentId)
    await this.detectAll()
    await writeClaudeSetting(this.settingsFile(slot), change)
    this.deps.diagnostics.event(agentId, 'claude setting', change.setting)
  }

  private claudeSlot(agentId: AgentId): Slot {
    const slot = this.registeredSlot(agentId)
    if (slot.def.id !== 'claude-code') {
      throw invalidParams(t('agent.noSettings', { agent: slot.def.name }))
    }
    return slot
  }

  // When an agent's harness compacts on its own.

  /** The agent's auto-compact setting, from its harness's own configuration. */
  async autoCompact(
    agentId: AgentId,
    config: readonly ConfigOption[] | undefined,
    codex: () => Promise<CodexRequest>,
  ): Promise<AutoCompactSettings> {
    return readAutoCompact(await this.compactPlace(agentId, config, codex))
  }

  /** Writes one value there; a session opened later reads it. */
  async setAutoCompact(
    agentId: AgentId,
    change: AutoCompactChange,
    codex: () => Promise<CodexRequest>,
  ): Promise<void> {
    await writeAutoCompact(await this.compactPlace(agentId, undefined, codex), change)
    this.deps.diagnostics.event(agentId, 'auto-compact', change.model === null ? 'all' : 'model')
  }

  private async compactPlace(
    agentId: AgentId,
    config: readonly ConfigOption[] | undefined,
    codex: () => Promise<CodexRequest>,
  ): Promise<CompactPlace> {
    const slot = this.registeredSlot(agentId)
    if (!takesAutoCompact(agentId)) {
      throw invalidParams(t('agent.noAutoCompact', { agent: slot.def.name }))
    }
    await this.detectAll()
    return {
      harness: slot.def.id,
      file: slot.def.id === 'codex' ? '' : await this.existingSettingsFile(slot),
      version: this.status(agentId).version,
      config,
      codex,
    }
  }

  // Codebuddy Code's site.

  /** A Codebuddy Code agent's site, from its settings file, and the shell variables over it. */
  async codebuddySettings(agentId: AgentId): Promise<CodebuddySettings> {
    const slot = this.codebuddySlot(agentId)
    await this.detectAll()
    const env = this.deps.env.agentEnv(slot.id)
    return {
      ...(await readCodebuddySite(this.settingsFile(slot))),
      shellOverrides: shellOverrides((name) => getEnv(env, name, this.deps.platform)),
    }
  }

  /** Writes the site into the settings file; the next start of the agent talks to it. */
  async setCodebuddySite(agentId: AgentId, change: CodebuddySiteChange): Promise<void> {
    const slot = this.codebuddySlot(agentId)
    await this.detectAll()
    await writeCodebuddySite(this.settingsFile(slot), change)
    this.deps.diagnostics.event(agentId, 'codebuddy site', change.site)
    await this.credentialsChanged(slot)
  }

  private codebuddySlot(agentId: AgentId): Slot {
    const slot = this.registeredSlot(agentId)
    if (slot.def.id !== 'codebuddy') {
      throw invalidParams(t('agent.noSite', { agent: slot.def.name }))
    }
    return slot
  }

  /** The agent's dsh home, where its `.credentials.yaml` lives. */
  private dshFolder(slot: Slot): string {
    const folder = this.configFolder(slot.id)
    if (!folder) throw new Error(t('agent.noConfigFolder', { agent: slot.name }))
    return folder
  }

  /** The first of the agent's settings files that exists, else the one it reads first. */
  private async existingSettingsFile(slot: Slot): Promise<string> {
    const { platform } = this.deps
    const env = this.deps.env.agentEnv(slot.id)
    const candidates =
      configLocations(
        slot.def.id,
        (name) => getEnv(env, name, platform),
        os.homedir(),
        platform,
        this.chosenFolder(slot),
      ).find((location) => location.id === 'settings')?.candidates ?? []
    for (const file of candidates) {
      if (
        await stat(file).then(
          (info) => info.isFile(),
          () => false,
        )
      )
        return file
    }
    if (!candidates[0]) throw new Error(t('agent.noSettingsFile', { agent: slot.name }))
    return candidates[0]
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
    if (!file) throw new Error(t('agent.noSettingsFile', { agent: slot.name }))
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
    slot.limitsError = null
    slot.resets = null
    slot.resetsError = null
    slot.resetsReadAt = 0
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
    if (slot.def.id === 'kimi' && method.id === 'login') {
      return formatCommand(
        { command: display.command, args: [display.args[0], '--login'], env },
        this.deps.platform,
      )
    }
    if (method.command) {
      return formatCommand({ command: method.command, args: method.args, env }, this.deps.platform)
    }
    return formatCommand(
      { command: display.command, args: [...display.args, ...method.args], env },
      this.deps.platform,
    )
  }

  status(agentId: AgentId): AgentStatus {
    const slot = this.slot(agentId)
    const { h } = slot
    // Signed in with an API key or a cloud project, an Antigravity agent has no plan to read.
    const consoleSignIn =
      slot.def.id === 'antigravity' &&
      slot.signInMethod !== null &&
      !ANTIGRAVITY_PLAN_SIGN_INS.includes(slot.signInMethod)
    const limitsReason = consoleSignIn ? 'console-managed' : slot.def.limitsReason
    const platform = this.deps.platform
    const display = this.display(slot)
    const init = slot.init
    const config = this.configIn(slot, this.deps.env.agentEnv(agentId))
    const active = this.running(slot) ? slot.launchConfig : null
    // The sign-in runs in a terminal without the folder, so its command carries the one in use.
    const signInFolder = (active ?? config)?.chosen
    const folderEnv: Record<string, string> =
      signInFolder && slot.def.configVariable ? { [slot.def.configVariable]: signInFolder } : {}
    // An added agent that signs in only with its key offers none of the agent's own methods.
    const declared = signsInWithKeyOnly(agentId) ? [] : (init?.authMethods ?? [])
    // Mistral Vibe offers its browser sign-in twice, under one name, once the client takes its page.
    const delegates = declared.some((method) => method.id === DELEGATED_SIGN_IN)
    const shown = declared.filter(
      (method) =>
        (!delegates || method.id !== 'browser-auth') &&
        !(slot.def.id === 'grok' && method.id === GROK_CACHED_SIGN_IN),
    )
    const authMethods: AgentAuthMethod[] = shown.map((method) => ({
      id: method.id,
      // Grok names its browser sign-in just "Grok"; its description says what the button does.
      name: slot.def.id === 'grok' && method.description ? method.description : method.name,
      ...(method.description ? { description: method.description } : {}),
      type: method.type,
      ...(method.type === 'agent' && handsOverPage(slot.def, method.id) ? { delegated: true } : {}),
      ...(method.type === 'env' && method.envVars
        ? {
            envVars: method.envVars.map((variable) => ({
              ...variable,
              set: this.deps.envKeyIsSet?.(agentId, variable.name) ?? false,
            })),
          }
        : {}),
      ...(method.type === 'terminal'
        ? { command: this.signInCommand(slot, display, method, folderEnv) }
        : {}),
    }))
    const { keySignIn, terminalSignIn } = slot.def
    if (keySignIn) {
      const method = authMethods.find((item) => item.id === keySignIn.method)
      if (method) {
        method.type = 'env'
        method.envVars = [
          {
            name: keySignIn.variable,
            optional: false,
            set: this.deps.envKeyIsSet?.(agentId, keySignIn.variable) ?? false,
          },
        ]
      }
    }
    if (terminalSignIn && this.has(agentId)) {
      const replaced = authMethods.filter((item) => terminalSignIn.replaces.includes(item.id))
      // agy 1.5.9 declares its terminal sign-in itself to a client that runs one; it goes first.
      const own = authMethods.find((item) => item.type === 'terminal')
      const kept = authMethods.filter((item) => !replaced.includes(item) && item !== own)
      const terminal: AgentAuthMethod | null =
        own ??
        (replaced.length > 0
          ? {
              id: `${slot.def.id}-terminal-login`,
              name: replaced.map((item) => item.name).join(' / '),
              type: 'terminal',
              command: formatCommand({ ...display, args: [] }, platform),
            }
          : null)
      authMethods.splice(0, authMethods.length, ...(terminal ? [terminal] : []), ...kept)
    }
    if (slot.def.id === 'qwen' && this.has(agentId)) {
      // Kettu's own copy runs as node and its script, which stays; only the launch words go.
      const launched = slot.def.launch.kind === 'package' ? (slot.def.launch.args ?? []) : []
      authMethods.push({
        id: 'qwen-terminal-login',
        name: t('agent.signIn.subscription'),
        type: 'terminal',
        command: formatCommand(
          { ...display, args: display.args.slice(0, display.args.length - launched.length) },
          platform,
        ),
      })
    }
    if (slot.def.id === 'grok' && this.has(agentId)) {
      // Its browser sign-in opens on this computer; a device code also signs in from elsewhere.
      const launched = slot.def.launch.kind === 'package' ? (slot.def.launch.args ?? []) : []
      authMethods.push({
        id: 'grok-device-login',
        name: t('agent.signIn.deviceCode'),
        type: 'terminal',
        command: formatCommand(
          {
            ...display,
            args: [
              ...display.args.slice(0, display.args.length - launched.length),
              'login',
              '--device-auth',
            ],
          },
          platform,
        ),
      })
    }
    if (slot.def.id === 'cursor' && this.has(agentId)) {
      // Its own method only uses a sign-in made with its CLI, which runs in a terminal.
      authMethods.push({
        id: 'cursor-terminal-login',
        name: t('agent.signIn.terminal'),
        type: 'terminal',
        command: formatCommand(
          { ...display, args: [...display.args.filter((arg) => arg !== 'acp'), 'login'] },
          platform,
        ),
      })
    }
    if (slot.def.id === 'kilo') {
      const method = authMethods.find((item) => item.type === 'terminal')
      if (method) method.command = formatCommand({ ...display, args: ['auth', 'login'] }, platform)
    }
    if (slot.def.id === 'opencode' && this.has(agentId)) {
      authMethods.push({
        id: 'opencode-login',
        name: 'OpenCode login',
        type: 'terminal',
        command: formatCommand({ ...display, args: ['auth', 'login'] }, platform),
      })
    }
    const capabilities = init?.capabilities ?? rememberedCapabilities(slot)
    const { launch } = slot.def
    const detection = h.detection
    const adapter = detection?.state === 'available' ? detection.adapter : null
    const update = this.updateOf(h)
    const installed = detection?.state === 'available' ? detection.release : undefined
    const harnessSettings = this.deps.settings().agents[slot.def.id]
    const color = slot.added ? agentColor(this.deps.settings().addedAgents, slot.id) : null
    const cliVersion = this.cliUpdateVersion(h)
    const cliCommand = cliVersion ? (this.cliCommands.get(h) ?? null) : null
    const own = this.ownProgram(h, init?.version ?? null)
    const replaces = this.replacesInstall(h)
    const program = programOf(slot.def)
    const cliCommandName =
      slot.def.cli?.command ?? own?.command ?? (replaces ? program?.command : undefined)
    const unused = detection?.unused
    return {
      id: slot.id,
      name: slot.name,
      harnessId: slot.def.id,
      harnessName: slot.def.name,
      isDefault: !slot.added,
      registered: this.has(agentId),
      uninstalled: harnessSettings?.uninstalled === true,
      uninstallCommand: slot.added ? null : (this.programUninstall(h)?.command ?? null),
      hidden: !slot.added && harnessSettings?.hidden === true,
      disabled: this.isDisabled(agentId),
      ...(color ? { color } : {}),
      apiKey:
        slot.def.id === 'claude-code' ||
        slot.def.id === 'codex' ||
        slot.def.id === 'deepseek' ||
        slot.def.id === 'codebuddy'
          ? { set: slot.apiKey, providers: slot.def.id === 'claude-code' }
          : null,
      state: slot.state,
      // Kettu's own install names its release when the program reports no version of its own.
      version: init?.version ?? h.binaryVersion ?? installed?.version ?? null,
      // None runs while the user's own program runs in its place.
      package:
        launch.kind === 'package' && !replaces
          ? {
              name: launch.package,
              version:
                (adapter?.current ?? adapter?.fallback)?.version ??
                this.versionChoice(h)?.wanted ??
                '',
              // An install below the floor runs too, when the floor cannot be installed.
              installed: !!(adapter?.current ?? adapter?.fallback),
              ...(launch.library ? { isSdk: true as const } : {}),
            }
          : null,
      release: installed
        ? { version: installed.version, registry: this.release(h) !== null }
        : null,
      signIn: slot.signIn,
      authMethods,
      canLogout: capabilities?.logout ?? false,
      account: slot.account,
      ...(slot.def.id === 'opencode'
        ? {
            providers: slot.providers,
            providersError: slot.providersError,
          }
        : {}),
      ...(slot.def.id === 'pi' ? { modelProviders: slot.modelProviders } : {}),
      ...(slot.def.id === 'deepseek' ? { balance: slot.balance } : {}),
      ...(slot.balances.length ? { balances: slot.balances } : {}),
      ...(limitsReason ? { limitsReason } : {}),
      ...(slot.def.sharesSignIn ? { sharesSignIn: true } : {}),
      ...(slot.def.movedAccounts
        ? {
            movedAccounts: {
              to: slot.def.movedAccounts.to,
              audience: t(slot.def.movedAccounts.audience),
              refused: slot.accountRefused,
            },
          }
        : {}),
      limits: [...slot.limits.values()],
      ...(slot.limitsError ? { limitsError: slot.limitsError } : {}),
      ...(slot.resets ? { resets: slot.resets } : {}),
      ...(slot.resetsError ? { resetsError: slot.resetsError } : {}),
      detail: slot.detail ?? h.adapterNote,
      reason:
        unavailable(slot.state) && detection?.state !== 'available' ? detection?.reason : null,
      installNotice: slot.def.install.notice ? t(slot.def.install.notice) : null,
      installUrl: unavailable(slot.state) ? slot.def.install.url : null,
      progress:
        slot.state === 'starting' || slot.state === 'installing' ? slot.progress.lastLines(5) : [],
      launchCommand: formatCommand(display, platform),
      binaryOverride: harnessSettings?.binaryPath ?? null,
      binaryCommand: launch.kind === 'binary' ? launch.command : null,
      program,
      unusedProgram:
        unused && program
          ? {
              command: program.command,
              path: unused.installed.path,
              version: unused.installed.version,
              why: unused.why,
            }
          : null,
      binaryPath:
        launch.kind === 'binary' && detection?.state === 'available'
          ? (detection.spec?.command ?? null)
          : null,
      update,
      updateCheckedAt: this.checkedAt(h),
      automatic: this.automaticStatus(h),
      versionWarning: this.versionWarning(h),
      failedVersion: h.failed
        ? { version: h.failed.version, reason: h.failed.reason, runs: this.ownVersion(h) }
        : null,
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
      cli: cliCommandName
        ? {
            command: cliCommandName,
            installed: detection?.cli ?? own?.installed ?? null,
            method: h.cliMethod,
            update: cliVersion && cliCommand ? { version: cliVersion, command: cliCommand } : null,
            checkable: this.programSource(h) !== null,
          }
        : null,
      configDir: config
        ? { runs: config.folder, active: active?.folder ?? null, created: !!slot.added?.created }
        : null,
      kettuServer: {
        runs: this.kettuOn(slot.id),
        active: this.running(slot) ? (slot.runtime?.kettu ?? null) : null,
      },
      skills: takesSkills(slot.id, this.kettuOn(slot.id)),
      capabilities: {
        loadSession: capabilities?.loadSession ?? false,
        listSessions: capabilities?.listSessions ?? false,
        resumeSession: capabilities?.resumeSession ?? false,
        closeSession: capabilities?.closeSession ?? false,
        deleteSession: capabilities?.deleteSession ?? false,
        forkSession: capabilities?.forkSession ?? false,
        forkAtMessage: capabilities?.forkAtMessage ?? false,
        steering: capabilities?.steering ?? false,
        ...(capabilities?.rewind ? { rewind: true } : {}),
        reports: this.hasLimits(slot.id) && !consoleSignIn,
        context: this.hasContext(slot.id),
        liveContext: this.driver(slot).reads?.context === true,
        ...(this.driver(slot).reads?.contextEstimates || slot.def.contextEstimates
          ? { contextEstimates: true }
          : {}),
        account:
          slot.def.id === 'opencode' ||
          (slot.def.reportsAccount ?? false) ||
          (capabilities?.authStatus ?? false),
        mcpHttp: capabilities?.mcpHttp ?? null,
        prompt: capabilities?.prompt ?? null,
      },
    }
  }

  statuses(): AgentStatus[] {
    return [...this.slots.keys()].map((agentId) => this.status(agentId))
  }

  /**
   * When the harness's versions were last checked: npm's check, or for one with a target, the
   * last read of the Registry's listing or the manifest; null for a harness whose own installer
   * updates it.
   */
  private checkedAt(h: Harness): number | null {
    if (!this.checksUpdates(h)) return null
    const reads = [this.listingReadAt, this.manifestReadAt].filter((at) => at !== null)
    const read = this.targeted(h) && reads.length > 0 ? Math.max(...reads) : null
    if (read === null || h.checkedAt === null) return read ?? h.checkedAt
    return Math.max(read, h.checkedAt)
  }

  /** How Kettu's own install follows its target, for its page; null for the other harnesses. */
  private automaticStatus(h: Harness): AgentStatus['automatic'] {
    // The user's own program, found in place of Kettu's install, keeps its own updates.
    const theirs =
      (h.def.launch.kind === 'binary' && h.detection?.state === 'available' && !this.release(h)) ||
      this.replacesInstall(h)
    if (!this.targeted(h) || theirs) return null
    const update = this.targetUpdate(h)
    const running = this.ownVersion(h)
    const back = !!update && !!running && compareVersions(update.adapterVersion, running) < 0
    const target = update ? this.target(h) : null
    return {
      on: this.automatic(h),
      moved: h.moved,
      back,
      ...(back && running ? { backReason: this.moveReason(h, running) } : {}),
      follows: followsRegistry(h.def) ? 'registry' : 'kettu',
      ...(target && unhashed(target) ? { noChecksum: true as const } : {}),
    }
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
    return [...this.slots.keys()].filter((id) => this.has(id))
  }

  /**
   * The user's own program of the agent's harness and the agent's environment, for the harness's
   * own commands such as Claude Code's `plugin`; null when detection found no program.
   */
  async harnessProgram(agentId: AgentId): Promise<{ program: string; env: Env } | null> {
    const slot = this.registeredSlot(agentId)
    await this.detectAll()
    const program = this.userProgram(slot.h)
    return program ? { program: program.path, env: this.deps.env.agentEnv(agentId) } : null
  }

  /** The agent's own configuration folder, as the agent resolves it; null when it has none. */
  configFolder(agentId: AgentId): string | null {
    const slot = this.slots.get(agentId)
    if (!slot) return null
    const { platform } = this.deps
    const env = this.deps.env.agentEnv(agentId)
    const locations = configLocations(
      slot.def.id,
      (name) => getEnv(env, name, platform),
      os.homedir(),
      platform,
      this.chosenFolder(slot),
    )
    return locations.find((location) => location.id === 'folder')?.candidates[0] ?? null
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
    const commands = this.statuses().flatMap((s) => [
      ...s.authMethods.flatMap((method) => (method.command ? [method.command] : [])),
      ...(s.providers ?? []).flatMap((provider) =>
        provider.loginCommand ? [provider.loginCommand] : [],
      ),
    ])
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
    const mine = this.userProgram(h)
    const key = [this.cliUpdateVersion(h), h.cliMethod, h.cliGlobal?.dir, mine?.path].join('\0')
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
/** The reset credits are not asked for twice within this, however a read was started. */
const RESETS_GAP_MS = 5_000
/** How soon a read that fell short of the credits' expiries is tried again. */
const RESETS_RETRY_MS = 20_000

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

/** Whether an agent method hands its sign-in page to the client, rather than opening a browser here. */
function handsOverPage(def: AgentDefinition, methodId: string): boolean {
  return methodId === DELEGATED_SIGN_IN || (def.pageSignIns?.includes(methodId) ?? false)
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
