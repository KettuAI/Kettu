// The contract between the renderer and the agent host, over the agent host port.

import type { CodebuddyShellOverride, CodebuddySite, PromptCacheTtl } from './agents'
import type { CompactUnit } from './auto-compact'
import type { DeviceAccessDecision } from './device-agent'
import type { ArtifactChanges } from './artifact-changes'
import type { ArtifactConsentAsk, ArtifactConsentRow, RuntimeAnswer } from './artifact-capabilities'
import type { ArtifactContent, ArtifactSession, ArtifactSummary, VersionSummary } from './artifacts'
import type { CommentAnchor, CommentThread } from './artifact-comments'
import type { CanvasEvent, CanvasState } from './artifact-canvas'
import type { CanvasOp } from './canvas-doc'
import type { ParamValue } from './artifact-params'
import type { PreviewStyle } from './artifact-runtime/page-messages'
import type { ArtifactExportFormat, ArtifactTypeInfo } from './artifact-types'
import type {
  BrowserCallAnswer,
  BrowserDeviceCall,
  BrowserOriginAnswer,
  BrowserOriginDecision,
} from './browser'
import type { ComputerAppDecision } from './computer-use'
import type { ControlOutcome, SurfaceAccessDecision } from './control'
import type { ContextBreakdown, ContextEstimates } from './context'
import type { DeviceFileContent, FileContent, FileList, FileSearch, FileWritten } from './files'
import type { ArtifactContentFile, BackgroundWork } from './host-control'
import type { HostLoad, HostLoadWatch } from './host-load'
import type { IdleReleaseState } from './idle-release'
import type {
  AgentOwnPlugins,
  CatalogServer,
  ConnectStart,
  MarketCatalog,
  MarketConnection,
  MarketConnections,
  MarketKeyState,
  MarketSearch,
  MarketSkill,
  MarketSkillRepository,
  MarketSkills,
  McpOAuth,
  SkillSource,
} from './marketplace'
import type {
  ListingChange,
  MarketAccount,
  MarketProblem,
  MarketPublished,
  MarketPublisher,
  MarketVersionFiles,
  MineListing,
  PublishDraft,
  PublishKind,
  PublishResult,
  PublishVisibility,
} from './market-publish'
import type { PluginNoticeKind } from './plugin-channels'
import type { ConvertFrom, PluginConverted } from './plugin-convert'
import type {
  BundlePlan,
  CommunityDirectory,
  CommunityInstalled,
  CommunityListing,
  CommunityWorkflow,
} from './market-community'
import type { PluginLinkResult, PluginMentionResult, PluginRefSource } from './plugin-refs'
import type {
  PluginViewActionInput,
  PluginViewActionResult,
  PluginViewParams,
  PluginViewResult,
} from './plugin-views'
import type { InstalledKettuPlugin, PluginPlan, PluginResource, PluginSource } from './plugins'
import type { MediaAuthorization, MediaOpenResult } from './media'
import type { ModelRequestRaw, ModelRequestsOverview, ModelRequestsPage } from './model-requests'
import type {
  MemoryDecision,
  MemoryDraft,
  MemoryEntry,
  MemoryImportResult,
  MemoryImportScan,
  MemoryOverview,
  MemoryScope,
} from './memory'
import type {
  BranchList,
  ChangedFile,
  CommitDetails,
  FileDiff,
  GitOperation,
  GitStatus,
  GitTools,
  IssueLookup,
  LogCommit,
  PullRequest,
  PullRequestState,
  ProjectWorktreeSettings,
  RepositoryVisibility,
  SessionWorktree,
  WorktreeInspection,
} from './git'
import type { PortConnectionState } from './port-rpc'
import type { PathCompletion } from './remote/host-admin'
import type { ReportOrigin } from './report'
import type {
  RoutineChanges,
  RoutineDraft,
  RoutineRef,
  RoutineRun,
  RoutineView,
  RunPage,
  RoutinesProblem,
} from './routines'
import type { AgentColor } from './settings'
import type { SettingsSection } from './settings-catalog'
import type { TurnPhase } from './turn-phase'
import type {
  SessionTaskRef,
  WorkflowAddSource,
  WireWorkflowEntry,
  WorkflowSettings,
  WorkflowSettingsChange,
  WorkflowSuggestion,
  StepPick,
  TaskStart,
  TaskSummary,
  TaskView,
} from './workflow'
import type { ClockRequest, UsageScope, UsageStatus, UsageSummary, UsageTotal } from './usage'
import type {
  AgentId,
  HarnessId,
  Attachment,
  ConfigOption,
  DigestedPage,
  DigestedSnapshot,
  OlderPage,
  PatchBatch,
  PlanItem,
  PromptCache,
  QueuedComments,
  ProjectHooksDecision,
  ProjectMcpDecision,
  ProblemReportOutcome,
  QuestionAnswer,
  FormValues,
  MarketPublishAsk,
  SessionSnapshot,
  SessionStatus,
  SlashCommand,
  CommandOrigin,
  StopReason,
  ThreadEntry,
  ToolKind,
  UserContent,
} from './thread'

export interface AttachmentBytes {
  mimeType: string
  bytes: ArrayBuffer
}

export interface AgentAccount {
  kind: 'account' | 'api_key' | 'external' | 'gateway' | 'none'
  label: string // "Claude Max", "ChatGPT Plus", "Anthropic API key"
  email: string | null
  /** The subscription's multiple of the base plan, such as "5x" of Claude Max; absent when unknown. */
  tier?: string
}

export interface PlanLimit {
  window: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | (string & {})
  label: string // "5-hour", "Weekly", "Weekly · Opus"
  usedPercent: number | null
  resetsAt: number | null
  state: 'ok' | 'warning' | 'reached' // from `status`: allowed, allowed_warning, rejected
  observedAt: number
  amount?: { used: number; total: number; unit: string }
  /**
   * The models a group's window counts, by the names the agent gives them, such as Antigravity's
   * "Gemini 3.8 Flash"; absent for a window that counts the whole plan.
   */
  models?: string[]
  /**
   * Set while extra usage covers this used-up window: the plan refuses requests and extra usage
   * lets them through. It ends with an event that says extra usage is not in use, when the window
   * resets, or when a read shows it not used up.
   */
  extraUsage?: true
}

/** The rate-limit reset credits an account holds: spending one restarts its windows at once. */
export interface PlanResets {
  count: number
  /**
   * Each credit and when it runs out, null for never: the soonest first, those that never run out
   * last. Absent when only the number could be read, so the expiries are unknown.
   */
  each?: { id: string; until: number | null }[]
  observedAt: number
}

/** Why the last read of the reset credits fell short: the sign-in, their details, or the read. */
export type ResetsError = 'sign-in-expired' | 'details' | 'failed'

/** The vendor's answer to spending a reset credit; only `reset` started the windows again. */
export type ResetSpendCode = 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed'

export type LimitsReason =
  | 'vendor-disallows'
  | 'harness-does-not-offer'
  | 'administrator-managed'
  | 'model-provider-managed'
  | 'not-yet-supported'
  // Signed in with an API key or a cloud project, whose use the provider's console shows.
  | 'console-managed'

export interface ProviderBalance {
  label: string
  amount: number
  currency: string
}

export interface AgentProvider {
  id: string
  name: string
  methods: { type: 'key' | 'oauth' | 'command' | 'external' | 'env'; label: string }[]
  accounts: {
    id: string | null
    label: string
    method: 'key' | 'oauth' | 'external' | 'env'
    needsAuth: boolean
    active?: boolean
  }[]
  loginCommand: string
  usage: {
    state: 'ready' | 'unsupported' | 'error'
    limits: PlanLimit[]
    balances: ProviderBalance[]
    observedAt: number
    error: string | null
  } | null
}

/** A provider an agent lists models from, as the agent names it, and how many it lists. */
export interface ModelProvider {
  id: string
  models: number
}

export interface AgentProviderAction {
  agentId: AgentId
  providerId: string
  action: 'logout' | 'activate' | 'set-key'
  credentialId?: string
  key?: string
}

/** A user message in the message outline: its first line and the title a model wrote, if any. */
export interface OutlineEntry {
  pos: number
  entryId: string
  text: string
  title: string | null
}

export interface OutlineTitle {
  pos: number
  title: string
}

/** The latest message of a session that holds every word of a search. */
export interface ConversationHit {
  sessionId: string
  pos: number
  entryId: string
  role: 'user' | 'agent'
  /** The message's text around the first match, on one line and cut at both ends. */
  snippet: string
  /** How many of the session's messages hold every word; absent from hosts before it was sent. */
  matches?: number
}

/** A message of one session that holds every word of a search in it. */
export interface SessionFindMatch {
  pos: number
  entryId: string
  role: 'user' | 'agent'
}

/** The search index is still being built: sessions done of those it started with. */
export interface SearchIndexing {
  done: number
  total: number
}

export type { ContextBreakdown, ContextList } from './context'

export type AgentState =
  | 'not-installed'
  | 'node-missing'
  | 'node-outdated'
  | 'available'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'failed'

export interface AgentAuthMethod {
  id: string
  name: string
  description?: string
  type: 'agent' | 'terminal' | 'env'
  envVars?: { name: string; optional: boolean; set: boolean }[]
  command?: string // for terminal methods: the agent's named command or its launch, quoted
  // For agent methods: hands its sign-in page to the client that asked, which opens it there.
  delegated?: boolean
}

/** A newer adapter or CLI than the installed one, found by `agents.checkUpdates`. */
export interface AgentUpdate {
  adapterVersion: string // the adapter version a fresh install takes
  cliVersion: string | null // the CLI that install carries, such as Claude Code or Codex
}

/** An install or update Kettu runs for an agent at the user's request. */
export interface AgentTask {
  kind: 'install' | 'update'
  state: 'running' | 'failed'
  command: string // what runs, quoted for the platform
  method: ProgramMethod | null // the route a binary agent's install or a program's update took
  progress: string[] // the latest output lines
  error: string | null // why it failed, in the user's terms
}

/**
 * Why Kettu's own install of a harness moved to another version: the ACP Registry lists it, Kettu's
 * compatibility manifest recommends it, the manifest says the one before does not work, or this
 * build of Kettu bundles it.
 */
export type VersionMoveReason = 'registry' | 'manifest' | 'broken' | 'bundled'

/** The user's own program a start runs, such as Claude Code's or Codex's CLI. */
export interface AgentCli {
  command: string // looked up on PATH, such as claude
  installed: InstalledCli | null // null: none found
  // How it was installed, read from where it lives; null when Kettu cannot tell.
  method: ProgramMethod | null
  // A newer version, from the daily check, and the command that updates it the way it was
  // installed; null when up to date, unchecked, or the way is unknown.
  update: { version: string; command: string } | null
  // Whether its newer versions can be read, by how it was installed; absent on older hosts.
  checkable?: boolean
}

export interface InstalledCli {
  path: string // as the adapter runs it, after resolving shims
  version: string | null
  variable: string | null // set by this variable in the environment, which then decides alone
  problem: InstalledCliProblem | null // why it cannot run
}

export type InstalledCliProblem =
  | { kind: 'unsupported' } // cannot run without a shell
  | { kind: 'failed'; reason: string } // its version could not be read
  | { kind: 'too-old'; minimum: string }

/**
 * Why detection found that a harness cannot run. `needs-node` carries the harness's own minimum
 * (null when it names none) and the version found (null when none was, or `unreadable` when
 * `node --version` did not answer); `needs-uv` the same for uv; `too-old` the user's program's;
 * `cannot-run` says why in the user's terms; `no-version` is no version for this computer.
 */
export type HarnessReason =
  | { kind: 'not-installed' }
  | { kind: 'needs-node'; minimum: string | null; installed: string | null; unreadable?: true }
  | { kind: 'needs-npm' }
  | { kind: 'needs-uv'; minimum: string | null; installed: string | null }
  | { kind: 'too-old'; minimum: string; installed: string | null }
  | { kind: 'cannot-run'; why: string }
  | { kind: 'no-version' }

/**
 * Why the user's own program of a harness Kettu also installs does not run: its version is outside
 * `range`, the npm range of versions Kettu runs; Kettu's compatibility manifest says it does not
 * work; or it cannot be run or asked its version (`detail`, in the user's terms).
 */
export type UnusedProgramReason =
  { kind: 'range'; range: string } | { kind: 'manifest' } | { kind: 'unusable'; detail: string }

/** A way Kettu can install a harness's program, such as OpenCode, in the order it prefers them. */
export interface AgentInstallMethod {
  id: 'brew' | 'npm' | 'script' | 'winget' | 'archive'
  label: string // what the page shows for the route: its command, or the archive's file name
  command: string // quoted for the platform, as the page shows it
  available: boolean // the tool it needs was found on the agent environment's PATH
}

/**
 * How the user's own program was installed: a route Kettu installs by, or a global install of
 * another package manager, which updates and removes it with its own commands.
 */
export type ProgramMethod = AgentInstallMethod['id'] | 'pnpm' | 'bun' | 'yarn'

/**
 * Where an install downloads from: the npm registry the user's npm configuration names for the
 * package (null when it could not be read), a release file the ACP Registry lists at its vendor's
 * address, the vendor's own address, Homebrew, WinGet, or PyPI through uv.
 */
export type InstallSource =
  | { kind: 'npm'; registry: string | null }
  | { kind: 'registry'; url: string }
  | { kind: 'vendor'; url: string }
  | { kind: 'brew' }
  | { kind: 'winget' }
  | { kind: 'pypi' }

/** Something an install needs on the computer, and whether it is there. */
export type InstallNeed =
  // `minimum` is the harness's own, such as 22.19.0; `found` the version on PATH.
  | { kind: 'node'; minimum: string | null; found: string | null; ok: boolean }
  | { kind: 'npm'; ok: boolean }
  | { kind: 'uv'; ok: boolean }

/** What one way of installing a harness brings, which the install window shows before it runs. */
export interface InstallDetails {
  /** An npm or uvx package or a release archive, by name; a vendor's command, which its route holds. */
  what: { kind: 'npm' | 'uvx' | 'archive'; name: string } | { kind: 'command' }
  /** The version it installs; null where the vendor's route takes its newest. */
  version: string | null
  source: InstallSource
  /** The folder it goes into; null where the route does not say, as for uv's cache or WinGet. */
  folder: string | null
  /** In bytes, when known; `packageOnly` when the package's dependencies are not counted. */
  size: { bytes: number; packageOnly: boolean } | null
  needs: InstallNeed[]
}

/** A way the install window offers to install a harness. */
export interface InstallRoute {
  /**
   * `copy` is Kettu's own install of the harness's npm or uvx package, which `agents.install` takes
   * without a method; the others are its methods.
   */
  id: 'copy' | AgentInstallMethod['id']
  /** The command it runs, or the archive's address, quoted for the platform; null for `copy`. */
  command: string | null
  /** The tool it runs with was found on the agent environment's PATH. */
  available: boolean
  /** Nothing installs now: uv fetches a uvx package the first time a session starts. */
  firstStart?: true
  details: InstallDetails
}

/** The ways to install a harness, the recommended first. */
export interface InstallOffer {
  routes: InstallRoute[]
  /** The vendor's install page; absent when it has none, and on older hosts. */
  guide?: string
}

export interface AgentStatus {
  id: AgentId
  name: string // the agent's: the harness's own for its default agent
  harnessId: HarnessId
  harnessName: string
  isDefault: boolean
  registered?: boolean // absent on older hosts; catalog entries are not necessarily agents
  uninstalled?: boolean // removed from Kettu; Install brings it back
  /** The command that removes the user's own program, when its install route has one. */
  uninstallCommand?: string | null
  hidden: boolean // a default agent hidden from the agent menu
  disabled?: boolean // turned off in Settings: never starts; absent on older hosts
  color?: AgentColor // an added agent's dot on its mark; absent for a harness's default agent
  // Whether Kettu handed this agent's harness an API key; null for a harness that takes none.
  apiKey: { set: boolean; providers: boolean } | null
  state: AgentState
  // From `initialize`, a binary agent's `--version`, or the `requires` program's (Pi's `pi`); for
  // Kettu's own install of a program that reports none, the release it installed.
  version: string | null
  // The adapter a start runs, the version it wants until one is installed; `isCli` for a package
  // that is the agent's CLI itself, which runs with no adapter, and `isSdk` for the agent's SDK,
  // which Kettu loads itself and which runs the agent's CLI.
  package: {
    name: string
    version: string
    installed: boolean
    isCli?: true
    isSdk?: true
  } | null
  // Kettu's own install that a start runs, a release archive or a uvx package, and its version;
  // `registry` when the ACP Registry lists its updates. Null while the user's own program runs or
  // nothing is installed, and absent on older hosts.
  release?: { version: string; registry: boolean } | null
  signIn: 'unknown' | 'signed-in' | 'required'
  authMethods: AgentAuthMethod[]
  canLogout: boolean
  account: AgentAccount | null // what the agent reports through `_auth/status_update`
  providers?: AgentProvider[]
  providersError?: string | null
  /**
   * The providers a harness that signs in to each one itself has models from, as it names them,
   * with how many models each lists (Pi); null until it first listed them, absent for the others
   * and on older hosts.
   */
  modelProviders?: ModelProvider[] | null
  /** A harness's balance at its vendor, read on its own: DeepSeek Harness's API key or account. */
  balance?: AgentProvider['usage']
  balances?: ProviderBalance[]
  limitsReason?: LimitsReason
  /** Its sign-in and session history are shared with the vendor's own apps (Antigravity). */
  sharesSignIn?: boolean
  /**
   * Accounts its vendor moved to another harness: that harness, who this one is still for, and
   * whether the agent refused its signed-in account as one of them (Gemini CLI to Antigravity).
   */
  movedAccounts?: { to: HarnessId; audience: string; refused: boolean }
  limits: PlanLimit[] // subscription windows, see plan limits in the session model
  limitsError?: string // why the last limits read failed, until one succeeds; `limits` stay
  /** Codex's reset credits on a ChatGPT sign-in; absent when none were read or it holds none. */
  resets?: PlanResets
  resetsError?: ResetsError
  detail: string | null // install hint or error message
  // Why it cannot run while `state` is `not-installed`, `node-missing` or `node-outdated`; null
  // otherwise, and absent on older hosts, which say it in `detail` alone.
  reason?: HarnessReason | null
  installUrl: string | null
  installNotice?: string | null // the vendor installer's effects, shown before installation
  progress: string[] // latest npm output or stderr lines while installing or starting
  launchCommand: string // as shown in Settings › Agents, quoted for the platform
  binaryOverride: string | null // the program picked in Settings, if any
  binaryCommand: string | null // the command a binary agent's launch runs; null for the others
  // The harness's program as its page names it, which one picked in Settings replaces; `onPath`
  // when Kettu looks for the user's own on PATH first. Null for a harness that runs none of its
  // own, and absent on older hosts.
  program?: { command: string; onPath: boolean } | null
  // The user's own program of a harness Kettu installs too, found but not run, and why: Kettu's
  // own install runs instead, or Install is offered. Null when there is none, and absent on older
  // hosts.
  unusedProgram?: {
    command: string
    path: string
    version: string | null
    why: UnusedProgramReason
  } | null
  // Where that program was found: on PATH, the one picked in Settings or Kettu's install; null
  // while none was, and for the others.
  binaryPath?: string | null
  update: AgentUpdate | null // from the last update check; null when up to date or unchecked
  // When that check finished; null for a binary agent unless Kettu installed it from the registry
  updateCheckedAt: number | null
  // How Kettu's own install of a harness follows the version it is given, from the ACP Registry or
  // Kettu's compatibility manifest (`follows`): whether it updates by itself, its last move, when
  // and why (`withdrawn` when it went back to an older version), whether the update on offer
  // goes back to an older version, and why, and whether it is an archive without a SHA-256 for
  // this platform (`noChecksum`), which only installs by hand. Null for the other harnesses, and
  // absent on older hosts; `follows`, the reasons and `noChecksum` are absent on older hosts too.
  automatic?: {
    on: boolean
    moved: {
      from: string
      to: string
      at: number
      withdrawn: boolean
      reason?: VersionMoveReason
    } | null
    back: boolean
    backReason?: VersionMoveReason
    follows?: 'registry' | 'kettu'
    noChecksum?: true
  } | null
  // The user's own program is a version Kettu's compatibility manifest says does not work:
  // `broken` when it names it, else it is outside `supported`; `recommended` is the version Kettu
  // checked last. Null when it is fine or not known, and absent on older hosts.
  versionWarning?: {
    version: string
    broken: boolean
    supported: string | null
    recommended: string | null
  } | null
  // A new version of Kettu's own install that failed to start, why, and the version that runs in
  // its place; null when none did, and absent on older hosts.
  failedVersion?: { version: string; reason: string; runs: string | null } | null
  updateSkipped: boolean // the user dismissed this update in the sidebar's notice
  task: AgentTask | null
  installMethods: AgentInstallMethod[] // a binary agent's ways to install; empty for the others
  cli: AgentCli | null // the user's own program a harness runs; null for the others
  // The configuration folder a start uses and the one the running process uses (null while none
  // runs); null for an agent whose folder cannot be chosen. `created`: Kettu made it.
  configDir: { runs: string; active: string | null; created: boolean } | null
  // Whether a start gets Kettu's MCP server, and whether the running process got it (null
  // while none runs).
  kettuServer: { runs: boolean; active: boolean | null }
  // Whether a session of the agent gets the skills turned on for it; absent on older hosts.
  skills?: boolean
  capabilities: {
    loadSession: boolean
    listSessions: boolean
    resumeSession: boolean
    closeSession: boolean
    deleteSession: boolean
    forkSession: boolean
    forkAtMessage: boolean // `session/fork` up to a message, through the adapters' fork point
    steering: boolean // `_session/steering` into a running turn
    rewind?: boolean // cuts a session's conversation before a turn, for an edit from a message
    reports: boolean // plan limits from its own report (`/usage`, `/status`)
    context: boolean // what fills the context from its own report (`/context`)
    liveContext: boolean // what fills the context from its connection through a running turn
    contextEstimates?: boolean
    account: boolean // names its account through `_auth/status_update` as it starts
    authStatus?: boolean // supports ACP's draft `auth/status`
    mcpHttp: boolean | null // MCP servers over HTTP: from `initialize` or the one remembered
    prompt: PromptCapabilities | null // what a prompt may carry; null until the agent has started
  }
}

/** ACP's `promptCapabilities`: the content a prompt may carry besides text and links. */
export interface PromptCapabilities {
  image: boolean
  audio: boolean
  embeddedContext: boolean
}

/**
 * What New session shows for an agent before a session exists, since ACP lists the options only in
 * answer to `session/new`. See config options in the session model.
 */
export interface AgentOptions {
  agentId: AgentId
  config: ConfigOption[] // from the agent's last `session/new`, at the agent's own values
  levels: Record<string, ConfigOption> // the `thought_level` option each model offered, by model
  remembered: Record<string, string | boolean> // the user's last values, by option id
  // The agent's own values in each folder, by `pathKey`, as its last `session/new` there gave them.
  defaults?: Record<string, Record<string, string | boolean>>
  observedAt: number
  provisional?: boolean // from a loaded or resumed session, so not the agent's own defaults
  // The models the user pinned to the top of its model menu, by value, in the order pinned.
  pinned?: string[]
  // The models its sessions last started on or switched to, by value, the latest first.
  recent?: string[]
  // The permission mode its new sessions start in, from the host's settings: sent with the
  // options, never stored with them.
  startMode?: string
}

/** How many models an agent's model menu may have pinned, all of them in its main list. */
export const MAX_PINNED_MODELS = 4
/** How many of an agent's recently used models the host keeps. */
export const MAX_RECENT_MODELS = 8

/** An agent's page in Settings › Agents: what its status leaves out, read when the page opens. */
export interface AgentDetails {
  /** The CLI an adapter runs, such as Claude Code inside its ACP adapter; null for the others. */
  cliVersion: string | null
  config: AgentConfigItem[]
}

/** One model's row of a Claude Code agent's auto-compact window setting. */
export interface ClaudeCompactRow {
  /** The model id as the settings file keys it, without a date or a context suffix. */
  model: string
  /** The name the agent lists it by; null for a model only the file names. */
  name: string | null
  /** The window in tokens the file saves for it; null when it saves none, so Claude Code picks. */
  window: number | null
}

/** The two settings a Claude Code agent's page edits, as its user settings file holds them. */
export interface ClaudeSettings {
  /** The window the file saves for every model without a row of its own; null when it has none. */
  defaultWindow: number | null
  compact: ClaudeCompactRow[]
  /** The file's `promptCacheTtl`; null when it has none. */
  promptCacheTtl: PromptCacheTtl | null
}

/** One change to those settings; a null value removes the key, and a null model means all. */
export type ClaudeSettingChange =
  | { setting: 'autoCompactWindow'; model: string | null; value: number | null }
  | { setting: 'promptCacheTtl'; value: PromptCacheTtl | null }

/** One model's row of an agent's auto-compact setting. */
export interface AutoCompactRow {
  /** The model as the harness's file keys it. */
  model: string
  /** The name the agent lists it by; null for a model only the file names. */
  name: string | null
  /** The value in the setting's unit; null when the file holds none, so the harness picks. */
  value: number | null
  /** What the file holds when it is no number of the unit, shown as written. */
  other: string | null
}

/** When an agent's harness compacts on its own, as its configuration holds it, in its own unit. */
export interface AutoCompactSettings {
  unit: CompactUnit
  /** The range a value is written in: tokens, or a whole percent for `percent`. */
  min: number
  max: number
  /** The value for every model without a row of its own; null when none is set. */
  all: number | null
  allOther: string | null
  /** A row per model for a harness that sets one per model; null when it sets one for all. */
  models: AutoCompactRow[] | null
  /** The file the value is kept in; null when the harness writes its own configuration. */
  file: string | null
}

/** One change; a null value removes the key, so the harness picks, and a null model means all. */
export interface AutoCompactChange {
  model: string | null
  value: number | null
}

/** What a Codebuddy Code agent's page edits in its settings file, and what overrides it. */
export interface CodebuddySettings {
  /**
   * The site the file names; `automatic` when it names none, so the agent follows its sign-in,
   * and `other` for a deployment Settings does not offer, whose value is `otherSite`.
   */
  site: CodebuddySite | 'automatic' | 'other'
  otherSite: string | null
  /** Shell variables set where the agent runs that win over these settings. */
  shellOverrides: CodebuddyShellOverride[]
}

/** The site to write; `automatic` removes the key. */
export type CodebuddySiteChange = { site: CodebuddySite | 'automatic' }

/** A place the agent reads its own configuration from, in the order Settings lists them. */
export interface AgentConfigItem {
  id: 'folder' | 'settings' | 'instructions'
  path: string
  exists: boolean
  env: string | null // the variable that moved it, such as CLAUDE_CONFIG_DIR; null at the default
  chosen: boolean // the agent's own folder, set by Kettu, whose env is then null
}

/** The groups Kettu's own tools are listed in, on its server's page in the Marketplace. */
export type McpToolGroup =
  | 'marketplace'
  | 'sessions'
  | 'artifacts'
  | 'browser'
  | 'computer'
  | 'devices'
  | 'terminal'
  | 'memory'
  | 'reports'
  | 'workflows'
  | 'settings'
  | 'plugins'

export interface McpToolSummary {
  name: string
  description: string
  group: McpToolGroup
  /** It waits for the user's answer in the session before it acts. */
  asks: boolean
}

/**
 * A folder checked for Marketplace › Published's From a folder: what the confirmation shows, as a
 * session's card does, and what keeps it from being published. `ask` is null when the folder is
 * nothing Kettu can publish.
 */
export interface PublishPlan {
  ask: MarketPublishAsk | null
  problems: MarketProblem[]
  /** The folder is a plugin of this harness, which converts into a Kettu plugin. */
  convertible?: ConvertFrom
}

/** For Marketplace › Installed: Kettu's own server, and where each agent keeps its own servers. */
export interface McpStatus {
  servers: {
    name: string // as agents know it: kettu
    title: string // Kettu
    builtIn: boolean // Kettu's own; the only server today
    running: boolean // it listens on 127.0.0.1
    error: string | null // why it does not, from its last try
    tools: McpToolSummary[] // as tools/list answers them, first sentence each
  }[]
  places: {
    agentId: AgentId // each agent that keeps MCP servers of its own in a file, in catalog order
    path: string // that file, found as the agent finds it
    exists: boolean
    env: string | null // the variable that moved it, such as CLAUDE_CONFIG_DIR; null at the default
    chosen: boolean // in the agent's own folder, set by Kettu, whose env is then null
    project: string // a project's own file, relative to its folder, such as .mcp.json
    listCommand: string | null // what lists them with their status in a session, /mcp, or null
  }[]
}

/** Where the agent environment came from, for Settings › Agents. */
/** The GitHub star prompt as this host keeps it. */
export interface GitHubStarState {
  /** Whether gh can star here; null until it has been asked, when a click tries it anyway. */
  gh: boolean | null
  starred: boolean
  /** The one-time card over the account row shows. */
  card: boolean
  /** New session's line shows. */
  line: boolean
}

export interface EnvironmentInfo {
  source: 'pending' | 'login-shell' | 'inherited' | 'fallback'
  shell: string | null
  resolvedAt: number | null
  durationMs: number | null
  warning: string | null // why it fell back, or a note such as the Windows PATH hint
  nodeVersion: string | null
  npmPath: string | null
}

export interface Project {
  path: string
  name: string
  missing: boolean // the folder no longer exists
  lastOpenedAt: number
  pinnedAt?: number | null // absent on hosts that do not support project pins
  // Its place in the host's order: null until the user moves a project there, absent on hosts
  // that cannot reorder projects. `projects.list` already gives them in this order.
  order?: number | null
}

/** The sidebar's No project group, which holds the sessions started without a project. */
export interface NoProject {
  pinnedAt: number | null
}

export type SessionAttention = 'none' | 'permission' | 'unread' | 'error'

/**
 * The `reason` in the `data` of the `not_found` that `sessions.create` fails with when its new
 * session was deleted, or its project removed, while it started: nothing is left to show.
 */
export const REMOVED_WHILE_STARTING = 'removed_while_starting'

/**
 * The `reason` in the `data` of the `not_found` that `permissions.respond` and
 * `browser.answerOrigin` and `computer.answerApp` fail with when another window or device answered
 * first; `device` there is
 * the one that did, null for a host's window.
 */
export const ALREADY_ANSWERED = 'already_answered'

/** A message the host kept to give back, to a session's composer or New session's (null). */
export interface ReturnedMessage {
  sessionId: string | null
  content: UserContent[]
}

/** One of a session's pull requests for its sidebar row; `state` null until gh has answered. */
export interface SessionPullRequest {
  url: string
  owner: string
  repo: string
  number: number
  state: PullRequestState | null
  failing: boolean // an open one has a failing check
}

export interface SessionSummary {
  id: string
  agentId: AgentId
  projectPath: string
  scratch: boolean // started with No project: projectPath is its own scratch folder
  title: string | null
  status: SessionStatus
  attention: SessionAttention
  // What waits for the user in this session alone: its requests, and on newer hosts its workflow
  // suggestions that wait for an answer, until answered or the session's next turn starts
  permissionCount: number
  createdAt: number
  updatedAt: number
  parentId: string | null
  origin: 'user' | 'subagent' | 'routine' | 'task'
  routine: RoutineRef | null // a routine's run, listed under its routine rather than its project
  task?: SessionTaskRef | null // a workflow step's session, listed under its task; absent from older hosts
  description: string | null // a subagent's purpose, as its parent described it
  missing: boolean // a subagent the parent's replay did not mention
  branch: string | null // the branch checked out when its last turn ended
  pr: { number: number; state: PullRequestState; url: string } | null
  prs?: SessionPullRequest[] // opened in it, then its branch's; absent from older hosts
  cache: PromptCache | null // the main thread's prompt cache as its last turn or request left it
  model: string | null // the model option then, for an estimate of the cache's lifetime
  pinnedAt: number | null // when the user pinned it; a top-level session only
  archivedAt: number | null // when the user archived it; off the sidebar while set
  acpSessionId: string | null // the harness's own id for it, which its CLI resumes; null until known
  prepared?: PreparedInfo // a prepared session, outside the index until its first message
  worktree?: SessionWorktree // the worktree it works in; absent when it works in projectPath
  agentWorktree?: { path: string; branch: string | null } // one its agent made for this subagent
  // Its latest plan's progress; null without one and for a closed session; absent from older hosts
  plan?: PlanProgress | null
  // When its running turn started; null between turns; absent from older hosts
  turnStartedAt?: number | null
  // The tool its running turn calls now; null while none runs; absent from older hosts
  activity?: SessionActivity | null
  // What its running turn does now, as the thread's nine dots act it out; null between turns;
  // absent from older hosts
  phase?: TurnPhase['phase'] | null
  // How its last turn ended; null while a turn runs and before any ended; absent from older hosts
  lastTurn?: LastTurn | null
}

/**
 * How a session's last turn ended. `failed` and `limit` are turns that ended with an error, the
 * latter refused by a used-up plan limit window; the others are the agent's own stop reasons.
 */
export interface LastTurn {
  reason: StopReason | 'failed' | 'limit'
  /** When it ended, in ms since the epoch. */
  endedAt: number
  /** The error's first line, for `failed` and `limit`. */
  error?: string
  /** The window that stopped it, for `limit`. */
  limit?: LastTurnLimit
  /**
   * When Kettu sends the session a message to carry on once the window has reset, in ms since the
   * epoch; null once the user chose not to, absent when none is planned.
   */
  continuesAt?: number | null
}

export interface LastTurnLimit {
  window: PlanLimit['window']
  /** The window's name, such as "5-hour". */
  label: string
  /** The account as the agent names it, or the agent's name without one. */
  account: string
  /** When the window resets, in ms since the epoch; null when unknown. */
  resetsAt: number | null
}

/**
 * What ending a session's agent stops: its turn, what waits for the user's answer and what it runs
 * in the background. Its subagents count with it; the commands of its terminals are not here.
 */
export interface RunningWork extends BackgroundWork {
  sessionId: string
  agentId: AgentId
  title: string | null
  turn: boolean
  /** Requests waiting for the user: approvals, questions, plan approvals and MCP requests. */
  waiting: number
}

/** An agent that can answer side questions for a session whose own agent cannot. */
export interface SideChatAgent {
  agentId: AgentId
  name: string
}

/** An agent the lightweight tasks' model may be pinned to: one that can ask in a hidden session. */
export interface LightAgent {
  agentId: AgentId
  name: string
}

/**
 * The tool call a session's main thread runs now, as its summary carries it: the latest one to
 * start of those still running. It changes when a call starts or ends, not with its output.
 */
export interface SessionActivity {
  /** The call's entry in the thread. */
  entryId: string
  toolKind: ToolKind
  title: string
  /** Its key argument: a command's first line, a file's path, a search's words or an address. */
  detail: string | null
  /** When the call started, in ms since the epoch. */
  startedAt: number
}

/** How far a session's latest plan got, as its summary carries it. */
export interface PlanProgress {
  done: number
  total: number
  /** The step in progress, by its index from 0, and the first line of its text; null for none. */
  current: { index: number; text: string } | null
}

/** What a session made, read from its stored thread for its card in the sidebar. */
export interface SessionOutputs {
  /** The artifacts its turns wrote and did not delete, by their latest write, latest first. */
  artifacts: { id: string; title: string }[]
  /** The github.com pull requests and issues its replies link, canonical, latest first. */
  references: string[]
  /** The start of its last reply, in Markdown. */
  reply: string | null
  /** How long its last ended turn took, in ms. */
  turnMs: number | null
  /** Its latest plan's items; absent from older hosts. */
  plan?: PlanItem[] | null
  /** When its running turn started; absent from older hosts. */
  turnStartedAt?: number | null
}

/**
 * Why a prepared session starts with another value than the one chosen: the agent does not offer
 * it, refused it, or a change outside Kettu replaced a remembered one. Names, not values.
 */
export interface StartNotice {
  reason: 'not_offered' | 'refused' | 'replaced'
  optionId: string
  category: ConfigOption['category']
  option: string
  type: 'select' | 'boolean'
  wanted: string | boolean
  actual: string | boolean | null // null when the session has no such option
}

/** One of Kettu's commands that a file holds, a plugin's or the user's own. */
export interface KettuCommand {
  /** The command's own name, as its file names it. */
  name: string
  description: string
  /** The arguments it takes, as `<file> [focus]`. */
  inputHint?: string
  origin: CommandOrigin
}

/** What a role suggests for the session it starts; each is a hint the person starting it may change. */
export interface RoleSuggests {
  /** An agent's id, or a harness's id for the first agent of that harness. */
  agent?: string
  /** A model's id or name as the agent lists it. */
  model?: string
  effort?: string
}

/** One of Kettu's roles that a file holds, a plugin's or the user's own. */
export interface KettuRole {
  /** What names it where a session starts as it: its own name, qualified when two share it. */
  ref: string
  title: string
  description: string
  suggests: RoleSuggests
  origin: CommandOrigin
}

/**
 * What only a prepared session carries: New session shows its options and slash commands before
 * the first message.
 */
export interface PreparedInfo {
  config: ConfigOption[]
  /** The slash commands its agent reported; absent from older hosts. */
  commands?: SlashCommand[]
  notices: StartNotice[]
  openedAt: number
}

export interface ImportableSession {
  acpSessionId: string
  title: string | null
  updatedAt: string | null
  imported: boolean // already in the session index
  /** Its prompt cache as its last request left it, for a Claude Code session used in the last hour. */
  cache?: PromptCache | null
  /** A Claude Code process outside Kettu, such as a terminal, still has it open. */
  held?: boolean
}

export interface TrafficRecord {
  at: number
  direction: 'in' | 'out'
  method: string | null
  size: number
  message: unknown
}

export interface AgentDiagnostics {
  status: AgentStatus
  capabilities: unknown
  traffic: TrafficRecord[]
  stderr: string
  events: { at: number; event: string; detail?: string }[]
  /** The installed adapter's `installed.json` and `package-lock.json`, for a package agent. */
  adapter: { installed: unknown; lock: unknown } | null
}

/**
 * The routines and, when `routines.json` could not be read, what became of it: the page says so
 * above the empty list and New routine still works.
 */
export interface RoutineList {
  routines: RoutineView[]
  problem: RoutinesProblem | null
}

export interface DiagnosticsBundle {
  createdAt: number
  appVersion: string
  platform: string
  environment: { PATH: string | null; SHELL: string | null; node: string | null }
  environmentInfo: EnvironmentInfo
  agents: AgentDiagnostics[]
  sessions: SessionSummary[]
  log: { at: number; level: 'info' | 'warn' | 'error'; message: string }[]
}

/** Every request the agent host accepts, keyed by method name. */
export interface HostContract {
  'agents.list': { params: void; result: AgentStatus[] }
  'agents.check': { params: { agentId?: AgentId }; result: AgentStatus[] }
  'agents.reloadEnvironment': { params: void; result: AgentStatus[] }
  // Detects again, then names the harnesses whose user program is found, in the order to add them.
  'agents.detectedPrograms': { params: void; result: HarnessId[] }
  'agents.environment': { params: void; result: EnvironmentInfo }
  // Its page, when it hands one over, comes to the asking port as `agents.signInLink`. A paired
  // device may not run an agent method that opens a browser on this computer instead.
  'agents.authenticate': { params: { agentId: AgentId; methodId: string }; result: void }
  // Stops the agent's sign-in in progress, whose `agents.authenticate` then rejects.
  'agents.cancelSignIn': { params: { agentId: AgentId }; result: void }
  'agents.logout': { params: { agentId: AgentId }; result: void }
  'agents.providerAction': { params: AgentProviderAction; result: void }
  'agents.retry': { params: { agentId: AgentId }; result: void }
  'agents.reinstall': { params: { agentId: AgentId }; result: void }
  // Asks npm for each package agent's latest adapter and the CLI it carries.
  'agents.checkUpdates': { params: void; result: AgentStatus[] }
  // Skips the agent's current update in the sidebar's notice, until a newer one.
  'agents.skipUpdate': { params: { agentId: AgentId }; result: void }
  // Offers the skipped update in the sidebar's notice again.
  'agents.unskipUpdate': { params: { agentId: AgentId }; result: void }
  // Both resolve once the task is done or cancelled, and reject with its error.
  'agents.update': { params: { agentId: AgentId }; result: void }
  // Updates the user's own program (Claude Code, Codex, OpenCode) the way it was installed.
  'agents.updateCli': { params: { agentId: AgentId }; result: void }
  // Hands the agent's harness an API key to keep; Kettu keeps no copy and never reads it back.
  'agents.setApiKey': {
    params: { agentId: AgentId; key: string; baseUrl?: string; model?: string }
    result: void
  }
  'agents.clearApiKey': { params: { agentId: AgentId }; result: void }
  'agents.install': {
    params: { agentId: AgentId; method?: AgentInstallMethod['id'] }
    result: void
  }
  // What each way of installing the harness brings, for the install window before it runs.
  'agents.installOffer': { params: { agentId: AgentId }; result: InstallOffer }
  // Removes Kettu's copy for the harness, and its own program too when asked.
  'agents.uninstall': {
    params: { agentId: AgentId; removeProgram?: boolean }
    result: { command: string | null; error: string | null }
  }
  // Stops a running task, or clears a failed one.
  'agents.cancelTask': { params: { agentId: AgentId }; result: void }
  // Reads the options of a running agent again, in the project's folder, when they are stale.
  'agents.readOptions': { params: { agentId: AgentId; projectPath: string | null }; result: void }
  // Reads the options of an agent none are cached for, starting it if need be, before New session
  // has a folder; rejects with the reason.
  'agents.readFirstOptions': { params: { agentId: AgentId }; result: void }
  'agents.refreshLimits': { params: { agentId: AgentId; force?: boolean }; result: void }
  /** Spends one reset credit, which cannot be undone; `requestId` makes a retry spend no second. */
  'agents.spendReset': {
    params: { agentId: AgentId; creditId: string; requestId: string }
    result: { code: ResetSpendCode }
  }
  'agents.details': { params: { agentId: AgentId }; result: AgentDetails }
  // A Claude Code agent's auto-compact windows and prompt cache duration, read from its settings
  // file; rejects with the reason when the file cannot be read.
  'agents.claudeSettings': { params: { agentId: AgentId }; result: ClaudeSettings }
  // Writes one of them into that file and nothing else in it.
  'agents.setClaudeSetting': {
    params: { agentId: AgentId; change: ClaudeSettingChange }
    result: void
  }
  // When the agent's harness compacts, read from its configuration in the harness's own unit;
  // rejects with the reason when that cannot be read.
  'agents.autoCompact': { params: { agentId: AgentId }; result: AutoCompactSettings }
  // Writes one value there and nothing else.
  'agents.setAutoCompact': { params: { agentId: AgentId; change: AutoCompactChange }; result: void }
  // A Codebuddy Code agent's site, read from its settings file, and what overrides it; rejects
  // with the reason when the file cannot be read.
  'agents.codebuddySettings': { params: { agentId: AgentId }; result: CodebuddySettings }
  // Writes the site into that file and nothing else in it.
  'agents.setCodebuddySite': {
    params: { agentId: AgentId; change: CodebuddySiteChange }
    result: void
  }
  'agents.refreshAccount': { params: { agentId: AgentId; force?: boolean }; result: void }
  'agents.listSessions': {
    params: { agentId: AgentId; projectPath: string; cursor?: string }
    result: { sessions: ImportableSession[]; nextCursor: string | null }
  }
  'agents.options': { params: void; result: AgentOptions[] }
  // Pins a model to the top of the agent's model menu, or unpins it; a fifth pin is refused.
  'agents.pinModel': { params: { agentId: AgentId; model: string; pinned: boolean }; result: void }
  // The agents the lightweight tasks' model may be pinned to; older hosts lack it.
  'agents.lightAgents': { params: void; result: { agents: LightAgent[] } }
  // A draft of a problem report's description, written by the agent the report is about, else the
  // one new sessions start with, from where the report was opened, the error and the host's recent
  // warnings, with the name of the agent that wrote it; a null draft when there is neither an error nor a
  // recent record to write from. `language` is the tag the user reads.
  'agents.draftReport': {
    params: {
      origin: ReportOrigin | null
      sessionId: string | null
      agentId: AgentId | null
      error: string | null
      language: string
    }
    result: { draft: string | null; agent: string | null }
  }
  // For Marketplace › Installed: Kettu's own server and each agent's own file.
  // Neither starts an agent, and neither reads an agent's configuration file.
  'mcp.status': { params: void; result: McpStatus }
  // Listens again when Kettu's MCP server does not, then sends main its port.
  'mcp.retry': { params: void; result: McpStatus }
  // The Marketplace's catalog of MCP servers from the registry, cached for a day; refresh skips the
  // cache, and cached answers from it however old, unless there is none.
  'market.catalog': { params: { refresh?: boolean; cached?: boolean }; result: MarketCatalog }
  // The registry's servers whose name has `query` in it, for the Marketplace's search.
  'market.search': { params: { query: string }; result: MarketSearch }
  // Which inputs of the servers Kettu keeps have a value; never the values.
  'market.keys': { params: void; result: MarketKeyState }
  // Signs in to a server Kettu keeps that uses OAuth; it must already be in the settings. The window
  // opens the browser page or shows the code; `market.connectionChanged` tells how it ended.
  'market.connect': { params: { serverId: string }; result: ConnectStart }
  // How a URL the user is adding by hand signs in, asked with the headers they typed: an OAuth flow
  // Kettu can do, or null when it needs none or offers none Kettu can do.
  'market.detectSignIn': {
    params: { url: string; headers: { name: string; value: string }[] }
    result: { oauth: McpOAuth | null }
  }
  'market.cancelConnect': { params: { loginId: string }; result: void }
  // Clears a server's tokens and keeps the server; every agent loses it at once.
  'market.disconnect': { params: { serverId: string }; result: void }
  'market.connections': { params: void; result: MarketConnections }
  // The plugins each Claude Code and Codex agent has of its own, which Kettu only lists.
  'market.ownPlugins': { params: { refresh?: boolean }; result: AgentOwnPlugins }
  // The skills catalog and each agent's own skills.
  'market.skills': { params: { refresh?: boolean; cached?: boolean }; result: MarketSkills }
  // One repository of the skills catalog, `<owner>/<repo>`, read as market.skills reads each.
  'market.skillRepository': {
    params: { id: string; refresh?: boolean }
    result: MarketSkillRepository
  }
  // Copies a skill's files onto the host; the caller then adds the entry to settings.marketplace.skills.
  'market.addSkill': { params: { source: SkillSource }; result: MarketSkill }
  // Any window's or device's answer to a Marketplace card: Publish (or Unlist) or Not now; the
  // first counts. On a first publish, Publish carries the publisher name, which is set before
  // anything else and refused with the reason when the service does not take it.
  'market.answerPublish': {
    params: {
      sessionId: string
      entryId: string
      decision: 'confirm' | 'later'
      visibility?: PublishVisibility
      notes?: string
      handle?: string
    }
    result: void
  }
  // Any window's or device's answer to a card an agent's change_settings shows: Change or Don't
  // change; the first counts.
  'settings.answerChange': {
    params: { sessionId: string; entryId: string; decision: 'change' | 'keep' }
    result: void
  }
  // Undo on a settings line: the rows go back to what they were, refused with `conflict` once one
  // of them changed again since, which takes the undo away.
  'settings.undoChange': { params: { sessionId: string; entryId: string }; result: void }
  // What was put off or refused, newest first, kept on the host to publish later.
  'market.publishDrafts': { params: void; result: { drafts: PublishDraft[] } }
  'market.discardPublishDraft': { params: { id: string }; result: void }
  // The Kettu Marketplace's public listings and the account's own Only me ones, matching `q` and
  // of `kind` when given, read again after a few minutes or on `refresh`. Reads no file of any.
  'market.community': {
    params: { q?: string; kind?: PublishKind; cursor?: string; refresh?: boolean }
    result: CommunityDirectory
  }
  'market.communityListing': { params: { id: string }; result: CommunityListing }
  // A workflow listing's flow for its page, before it is added: only the current version's
  // `workflow.yaml` is read, checked and parsed; nothing is kept on the host or run.
  'market.communityWorkflow': { params: { id: string }; result: CommunityWorkflow }
  // Where every item installed from the Kettu Marketplace stands with its listing.
  'market.communityInstalled': { params: { refresh?: boolean }; result: CommunityInstalled }
  // Downloads a workflow listing's current version, checks every file and the workflow, and writes
  // it into the workflow library unapproved, in place of the version it has of the listing.
  'market.addCommunityWorkflow': { params: { id: string }; result: WireWorkflowEntry }
  'market.reportCommunity': { params: { id: string; message: string }; result: void }
  // A server listing's MCP bundle, in two steps: prepare downloads, checks and stages it and says
  // what it runs and asks for, running nothing; commit moves it into place with the values its
  // arguments take and gives the server to keep; cancel removes what was staged.
  'market.bundlePrepare': { params: { id: string }; result: BundlePlan }
  'market.bundleCommit': {
    params: { token: string; values: Record<string, string> }
    result: CatalogServer
  }
  'market.bundleCancel': { params: { token: string }; result: void }
  // Marketplace › Published: the host's Kettu account while it is signed in with Kettu's services
  // on, which alone shows the tab; then what it published, its drafts and where each came from.
  'market.account': { params: void; result: { account: MarketAccount | null } }
  'market.published': { params: void; result: MarketPublished }
  'market.setPublisher': { params: { handle: string }; result: MarketPublisher }
  'market.updateListing': { params: { id: string; change: ListingChange }; result: MineListing }
  'market.withdrawVersion': { params: { id: string; version: string }; result: MineListing }
  'market.deleteListing': { params: { id: string }; result: void }
  'market.versionFiles': { params: { id: string; version: string }; result: MarketVersionFiles }
  // From a folder: the check and what to confirm, then the publish once the user confirmed it, as
  // a session's card does; a draft's own notes, visibility and session go with it.
  'market.checkFolder': { params: { path: string; draftId?: string }; result: PublishPlan }
  // A Claude Code or Codex plugin's folder, or one of the account's own listings of such a plugin,
  // written as a Kettu plugin into a new folder; the original is not changed.
  'market.convertFolder': { params: { path: string }; result: PluginConverted }
  'market.convertListing': { params: { id: string }; result: PluginConverted }
  'market.publishFolder': {
    params: {
      path: string
      draftId?: string
      visibility?: PublishVisibility
      notes?: string
      handle?: string
    }
    // `held` is the version the service holds for review, which it lists only after it.
    result: PublishResult
  }
  'projects.list': { params: void; result: Project[] }
  'projects.add': { params: { path: string }; result: Project }
  'projects.remove': { params: { path: string }; result: void }
  'projects.touch': { params: { path: string }; result: void }
  // A null path pins the No project group.
  'projects.pin': { params: { path: string | null; pinned: boolean }; result: void }
  // Puts a project just before another of the same host, or last with a null `before`.
  'projects.move': { params: { path: string; before: string | null }; result: void }
  'projects.noProject': { params: void; result: NoProject }
  // How the project names and prepares its sessions' worktrees.
  'projects.worktreeSettings': { params: { path: string }; result: ProjectWorktreeSettings }
  // A device needs the owner's leave to use the terminal to change these, as they run a command.
  'projects.setWorktreeSettings': {
    params: { path: string; settings: ProjectWorktreeSettings }
    result: void
  }
  // The entries of a folder on the host that start as `path`'s last part does, for a path being
  // typed: absolute, or `~` for the home folder. It only reads; a folder it cannot read lists none.
  'paths.complete': { params: { path: string }; result: PathCompletion }
  'sessions.list': { params: { projectPath?: string }; result: SessionSummary[] }
  'sessions.create': {
    // projectPath null: No project, in a new scratch folder.
    // options: config values to start with, by option id.
    // prompt: the first message, sent as the first turn once the session has started.
    // preparedId: the window's prepared session, adopted instead of a new `session/new`.
    params: {
      agentId: AgentId
      projectPath: string | null
      parentId?: string
      options?: Record<string, string | boolean>
      prompt?: UserContent[]
      preparedId?: string
      // A new worktree, cut from `base`, to work in; `branch` is the user's name for its branch.
      worktree?: { base: string; branch?: string }
      // A role to start as, by its `ref`: its instructions go to the agent with the session.
      role?: string
    }
    result: SessionSummary
  }
  // Routines: the saved prompts and their runs. See routines.
  'routines.list': { params: void; result: RoutineList }
  'routines.create': { params: RoutineDraft; result: RoutineView }
  'routines.update': { params: { routineId: string; changes: RoutineChanges }; result: RoutineView }
  'routines.delete': { params: { routineId: string }; result: void }
  // `busy` while the routine already has an active run.
  'routines.runNow': { params: { routineId: string }; result: RoutineRun }
  // Drops a queued run, or stops a working one as Stop does.
  'routines.cancelRun': { params: { runId: string }; result: void }
  'routines.runs': {
    params: { routineId: string; before?: number }
    result: RunPage
  }
  // The routine's page is shown: its ended runs count as seen.
  'routines.markSeen': { params: { routineId: string }; result: void }
  // Kettu's plugins: packages in the Agent Plugins format, installed on the host. See plugins.
  'plugins.list': { params: void; result: { plugins: InstalledKettuPlugin[] } }
  // Reads a package from its source and says what it holds and would run. Nothing is installed
  // and nothing of it runs; the answer's token names the package for plugins.install.
  'plugins.inspect': { params: { source: PluginSource }; result: PluginPlan }
  // Installs the package an inspection showed, once the user confirmed it: its skills and MCP
  // servers go into settings.marketplace marked with the plugin, its workflows into the library.
  'plugins.install': { params: { token: string }; result: InstalledKettuPlugin }
  'plugins.discard': { params: { token: string }; result: void }
  // Removes the plugin with every item it brought.
  'plugins.uninstall': { params: { pluginId: string }; result: void }
  'plugins.setEnabled': {
    params: { pluginId: string; enabled: boolean }
    result: InstalledKettuPlugin
  }
  // Sets a setting the plugin declares, other than a secret, to a value its declaration takes.
  'plugins.setSetting': {
    params: { pluginId: string; key: string; value: string | boolean }
    result: InstalledKettuPlugin
  }
  // Sets a secret the plugin declares, or with null clears it. The host keeps it in the system's
  // key store and never gives it back: the plugin's `secretsSet` only says it is set.
  'plugins.setSecret': {
    params: { pluginId: string; key: string; value: string | null }
    result: InstalledKettuPlugin
  }
  // Picks which kinds of notice go to one of the plugin's declared channels, in place of what it
  // had; none turns the channel off.
  'plugins.setChannelKinds': {
    params: { pluginId: string; channel: string; kinds: PluginNoticeKind[] }
    result: InstalledKettuPlugin
  }
  // Copies a development plugin's folder again, in place of the copy installed.
  'plugins.reload': { params: { pluginId: string }; result: InstalledKettuPlugin }
  // Looks for newer versions, of one plugin or all: a newer one is installed and the one before
  // kept, but one that adds a script or asks for more permissions waits as the plugin's `held`.
  'plugins.checkUpdates': {
    params: { pluginId?: string }
    result: { plugins: InstalledKettuPlugin[] }
  }
  // The user's answer to an update that waits: install it, or stay on the version in place.
  'plugins.applyUpdate': { params: { pluginId: string }; result: InstalledKettuPlugin }
  'plugins.declineUpdate': { params: { pluginId: string }; result: InstalledKettuPlugin }
  // Goes back to the version before the last update.
  'plugins.rollBack': { params: { pluginId: string }; result: InstalledKettuPlugin }
  // A view of a plugin that is on, as its script gives it now. A script that fails, hangs or
  // answers badly gives `ok: false` with why, never an error, so one view alone shows it.
  'plugins.viewData': {
    params: { pluginId: string; viewId: string; params?: PluginViewParams }
    result: PluginViewResult
  }
  // Tells a view's script that one of its actions ran, with a form's values, and says what it answered.
  'plugins.viewAction': {
    params: { pluginId: string; viewId: string; params?: PluginViewParams } & PluginViewActionInput
    result: PluginViewActionResult
  }
  // Runs an action a plugin declares for Search. Its answer may open a pane of the plugin; like a
  // view's, a failure is `ok: false` with why, never an error.
  'plugins.actionRun': {
    params: { pluginId: string; actionId: string }
    result: PluginViewActionResult
  }
  // What the plugins that are on declare for the composer's `@` menu and for links in replies.
  'plugins.refs': { params: void; result: { plugins: PluginRefSource[] } }
  // The items a plugin's mention source offers for what was typed after the `@`. A script that
  // fails, hangs or answers badly gives `ok: false` with why, never an error.
  'plugins.mentionSearch': {
    params: { pluginId: string; source: string; query: string }
    result: PluginMentionResult
  }
  // The card a plugin gives for a link in a reply, when it names the address.
  'plugins.linkCard': {
    params: { pluginId: string; link: string; url: string }
    result: PluginLinkResult
  }
  // The commands, roles, themes or templates of the plugins that are on, with each one's file.
  'plugins.resources': {
    params: { kind: 'commands' | 'roles' | 'themes' | 'templates' }
    result: { items: PluginResource[] }
  }
  // Kettu's commands that the plugins that are on and the user's own folder hold, for the slash list.
  'commands.list': { params: void; result: { commands: KettuCommand[] } }
  // Kettu's roles that the plugins that are on and the user's own folder hold, for New session.
  'roles.list': { params: void; result: { roles: KettuRole[] } }
  // Workflows: the user's library. See workflow; an older host also sends the ones it shipped with.
  'workflows.list': { params: void; result: WireWorkflowEntry[] }
  'workflows.read': {
    params: { workflowId: string }
    result: { entry: WireWorkflowEntry; text: string | null }
  }
  // Unapproved until `workflows.approve` names the hash the user was shown.
  'workflows.add': { params: WorkflowAddSource; result: WireWorkflowEntry }
  // Reads a GitHub workflow again; a changed file waits for approval again.
  'workflows.update': {
    params: { workflowId: string }
    result: { entry: WireWorkflowEntry; changed: boolean }
  }
  'workflows.approve': { params: { workflowId: string; hash: string }; result: WireWorkflowEntry }
  'workflows.remove': { params: { workflowId: string }; result: void }
  // Who does a step for every task of the workflow; null goes back to Auto.
  'workflows.pin': {
    params: { workflowId: string; stepId: string; pick: StepPick | null }
    result: WireWorkflowEntry
  }
  'workflows.settings': { params: void; result: WorkflowSettings }
  'workflows.setSettings': { params: WorkflowSettingsChange; result: WorkflowSettings }
  // The cards the workflow tools leave in a session: a suggestion to run a requirement through a
  // workflow, and a workflow an agent wrote for the user to keep.
  'workflows.suggestions': { params: { sessionId: string }; result: WorkflowSuggestion[] }
  // The file a card drew, for View file.
  'workflows.suggestionFile': { params: { id: string }; result: { text: string } }
  // Start (Retry after a failed item) answers once Start is under way; `workflows.suggestion`
  // events follow its items. Decline is Do it here, reconsider is Use it instead.
  'workflows.answerSuggestion': {
    params: {
      id: string
      answer: 'start' | 'decline' | 'another' | 'reconsider' | 'save' | 'not_save'
      // The first step's agent and its option values, as the session runs them.
      agentId?: AgentId
      options?: Record<string, string | boolean>
    }
    result: WorkflowSuggestion
  }
  // Tasks: a requirement run through a workflow, one session per step.
  'tasks.list': { params: void; result: TaskSummary[] }
  'tasks.get': { params: { taskId: string }; result: TaskView }
  // The summaries of its steps' sessions still there, which the session list leaves out.
  'tasks.sessions': { params: { taskId: string }; result: SessionSummary[] }
  // `from` is the session whose agent suggested it.
  'tasks.start': { params: TaskStart & { from?: { sessionId: string } }; result: TaskView }
  // Approves what a step handed in, or sends it back to the same step with a note.
  'tasks.review': {
    params: { taskId: string; roundId: string; approve: boolean; note?: string }
    result: TaskView
  }
  // The user's outcome on a step the workflow gives them.
  'tasks.answer': {
    params: { taskId: string; roundId: string; outcome: string; note?: string }
    result: TaskView
  }
  // Lets a step that waits for the user go on.
  'tasks.retry': { params: { taskId: string; stepId: string; note?: string }; result: TaskView }
  'tasks.cancel': { params: { taskId: string }; result: TaskView }
  // A task that is not running, with its steps' sessions.
  'tasks.delete': { params: { taskId: string }; result: void }
  // A note for the running steps and every later one.
  'tasks.note': { params: { taskId: string; text: string }; result: TaskView }
  // Who does a step for this task only; null goes back to what the workflow's page says.
  'tasks.pin': {
    params: { taskId: string; stepId: string; pick: StepPick | null }
    result: TaskView
  }
  'tasks.update': {
    params: {
      taskId: string
      title?: string
      pinned?: boolean
      archived?: boolean
      unread?: boolean
    }
    result: TaskView
  }
  // Save as my workflow: the workflow an agent wrote for a task that ended done, into the library.
  'tasks.saveWorkflow': { params: { taskId: string }; result: WireWorkflowEntry }
  // Publish to the Marketplace: asks the agent of the conversation the task started from to make
  // that workflow general and publish it, which waits for the user in its card.
  'tasks.publishWorkflow': { params: { taskId: string }; result: void }
  // The window's prepared session for New session; `replace` opens a new one even when it holds one.
  'sessions.prepare': {
    params: {
      agentId: AgentId
      projectPath: string | null
      parentId?: string
      options?: Record<string, string | boolean>
      replace?: boolean
    }
    result: SessionSummary
  }
  'sessions.discard': { params: { sessionId: string }; result: void }
  // `fork`: a copy of the session is imported instead, for one another program still has open.
  'sessions.import': {
    params: { agentId: AgentId; projectPath: string; acpSessionId: string; fork?: boolean }
    result: SessionSummary
  }
  'sessions.open': {
    params: { sessionId: string }
    result: SessionSnapshot
    deviceResult: SessionSnapshot | DigestedSnapshot
  }
  // With `from`, every entry from that position on, as a replica that holds older pages needs.
  'sessions.snapshot': {
    params: { sessionId: string; from?: number }
    result: SessionSnapshot
    deviceResult: SessionSnapshot | DigestedSnapshot
  }
  // With `from`, reaching back to the turn holding that position, for a jump in the outline.
  'sessions.page': {
    params: { sessionId: string; before: number; from?: number }
    result: OlderPage
    deviceResult: OlderPage | DigestedPage
  }
  // One entry whole, as a device whose page held its tool output as a digest opens it.
  'sessions.entry': { params: { sessionId: string; entryId: string }; result: ThreadEntry }
  // What waits for the user's answer in the session, in thread order: what its summary's
  // `permissionCount` counts. No entries for a closed session, where none waits. `askedAt`: when
  // each began to wait, by entry id, in ms since the epoch; absent from older hosts.
  // `suggestions`: the workflow suggestions that wait for Start or Do it here, which the count
  // includes, until answered or the session's next turn starts; `workflows.answerSuggestion`
  // answers them, and one a turn passed too. Absent from older hosts.
  'sessions.requests': {
    params: { sessionId: string }
    result: {
      entries: ThreadEntry[]
      askedAt?: Record<string, number>
      suggestions?: WorkflowSuggestion[]
    }
  }
  'sessions.outline': { params: { sessionId: string }; result: { entries: OutlineEntry[] } }
  // The session's requests to its model, read from the agent's own record of the session: the
  // newest page, or the one before `before`. Null when Kettu cannot read this agent's record.
  'sessions.modelRequests': {
    params: { sessionId: string; before?: string }
    result: ModelRequestsPage | null
  }
  // What the whole record holds beyond its pages: the request count, the cost the agent reckons
  // and the system prompt and tools. Null as for `sessions.modelRequests`.
  'sessions.modelRequestsOverview': {
    params: { sessionId: string }
    result: ModelRequestsOverview | null
  }
  // A request's records as the agent wrote them, `raw` naming them as a page gave it, or `system`
  // for the system prompt and tools; long strings folded unless `full`.
  'sessions.modelRequestRaw': {
    params: { sessionId: string; raw: string; full?: boolean }
    result: ModelRequestRaw
  }
  // The sessions whose messages hold every word of `query`, most recently updated first, each
  // with its latest such message; the sessions a session list shows, at most 100. Empty for a
  // query of fewer than 2 characters. `indexing` is present while the index is built, and the
  // hits may then be fewer than there are.
  'sessions.search': {
    params: { query: string }
    result: { hits: ConversationHit[]; indexing?: SearchIndexing | null }
  }
  // The messages of one session that hold every word of `query`, oldest first, for finding in the
  // session on screen: user messages and replies as in `sessions.search`, at most 500, the
  // newest when there are more (`capped`). Empty for a query of fewer than 2 characters.
  'sessions.find': {
    params: { sessionId: string; query: string }
    result: { matches: SessionFindMatch[]; capped: boolean; indexing?: SearchIndexing | null }
  }
  // What the session made, for its card in the sidebar; empty for a session without a thread.
  'sessions.outputs': { params: { sessionId: string }; result: SessionOutputs }
  // Summarizes the messages without a title; empty while a summary of the session runs.
  'sessions.outlineTitles': { params: { sessionId: string }; result: { titles: OutlineTitle[] } }
  'sessions.watch': { params: { sessionId: string }; result: void }
  'sessions.unwatch': { params: { sessionId: string }; result: void }
  // The sessions a port shows in front, none for a page; a turn that ends out of view is unread.
  'sessions.show': { params: { sessionIds: string[] }; result: void }
  'sessions.prompt': { params: { sessionId: string; content: UserContent[] }; result: void }
  // The user started typing in it: a Claude Code session whose agent was let go attaches now, so
  // the message need not wait for its start. Nothing is sent; unused, it is let go again.
  'sessions.attachEarly': { params: { sessionId: string }; result: void }
  'sessions.cancel': { params: { sessionId: string }; result: void }
  // What ending these sessions and their sub-sessions would stop, for the ones with any.
  'sessions.runningWork': { params: { sessionIds: string[] }; result: { sessions: RunningWork[] } }
  // The memory state, the rule idle Claude Code sessions follow and any version in fallback.
  'sessions.idleRelease': { params: void; result: IdleReleaseState }
  // The host's load now, then `host.load` every LOAD_READ_MS to this port until the watch's lease
  // of LOAD_LEASE_MS ends; asking again renews it. The host reads its load only while watched.
  'host.load.watch': { params: void; result: HostLoadWatch }
  'host.load.unwatch': { params: void; result: void }
  // Stops one background task of the session, as the session board's Stop does.
  'sessions.stopTask': { params: { sessionId: string; taskId: string }; result: void }
  // The end of a background task's output, at most 8 KiB, for the session board.
  'sessions.taskOutput': {
    params: { sessionId: string; taskId: string }
    result: { output: string; truncated: boolean }
  }
  'sessions.retry': { params: { sessionId: string }; result: void }
  // Drops the continuation Kettu planned after the plan window that stopped the last turn resets.
  'sessions.cancelContinue': { params: { sessionId: string }; result: void }
  // Asks a side question, answered beside the session; the answer arrives in `sideChat` patches.
  // `agentId` picks the agent that answers for a session whose own agent cannot, and is kept.
  'sessions.sideAsk': {
    params: { sessionId: string; question: string; quote?: string; agentId?: AgentId }
    result: void
  }
  // Stops the side question being answered.
  'sessions.sideStop': { params: { sessionId: string }; result: void }
  // Empties the side chat, or with `undo` brings back what the last clear emptied.
  'sessions.sideClear': { params: { sessionId: string; undo?: boolean }; result: void }
  // The agents on this host that can answer side questions for a session whose own cannot.
  'sessions.sideAgents': { params: { sessionId: string }; result: { agents: SideChatAgent[] } }
  // Takes the session back to before `entryId`, one of the user's messages: the turns from it on
  // are set aside until the next send, and its content comes back for the composer. `draft` is
  // what the composer held, which Put back gives back.
  'sessions.rewind': {
    params: { sessionId: string; entryId: string; draft: UserContent[] }
    result: { content: UserContent[] }
  }
  // Brings back the turns an edit set aside, with the draft the composer held before it.
  'sessions.putBack': { params: { sessionId: string }; result: { draft: UserContent[] } }
  // `entryId`: a reply's agent message, to fork the session up to its turn; see the session model.
  // A fork of a session in a worktree gets its own, from the source's branch, unless `same`.
  'sessions.fork': {
    params: { sessionId: string; entryId?: string; worktree?: 'new' | 'same' }
    result: SessionSummary
  }
  // What removing the session's worktree would lose, and the other sessions still in it.
  'worktrees.inspect': {
    params: { sessionId: string }
    result: WorktreeInspection & { others: string[] }
  }
  // Removes it, and its branch when `delete` and safe; refused with `conflict` when it changed
  // since `expected` was read.
  'worktrees.remove': {
    params: { sessionId: string; branch: 'keep' | 'delete'; expected: WorktreeInspection }
    result: SessionSummary
  }
  'worktrees.retrySetup': { params: { sessionId: string }; result: void }
  // Goes on without the setup command; what waited for it is sent.
  'worktrees.skipSetup': { params: { sessionId: string }; result: void }
  // The output kept of the last setup run, or with `from` what it wrote after that offset:
  // `log` starts at `start` and ends at `end`, counted in characters from the run's start, and a
  // `start` other than `from` means the kept output no longer reaches back there.
  'worktrees.setupLog': {
    params: { sessionId: string; from?: number }
    result: { log: string; start?: number; end?: number }
  }
  // Hands the session to another agent between turns and sends `content` as its first turn;
  // `options` are the values chosen for that agent, `summarize` asks it to summarize first.
  'sessions.switchAgent': {
    params: {
      sessionId: string
      agentId: AgentId
      content: UserContent[]
      options?: Record<string, string | boolean>
      summarize?: boolean
    }
    result: void
  }
  'sessions.context': { params: { sessionId: string }; result: ContextBreakdown | null }
  'sessions.contextEstimates': { params: { sessionId: string }; result: ContextEstimates | null }
  'sessions.queue': {
    /** `comments` for a message built from comments on passages, which its queue row shows. */
    params: { sessionId: string; content: UserContent[]; comments?: QueuedComments }
    result: { itemId: string | null } // null when it was sent at once
  }
  /**
   * Runs a shell code block of the session's agent's reply in a new terminal of the session, and
   * unless `notify` is false tells the agent which, queued while a turn runs. `notified` is false
   * when that message could not go, while the terminal runs anyway.
   */
  'sessions.runCommand': {
    params: { sessionId: string; command: string; notify: boolean }
    result: { terminalId: string; notified: boolean }
  }
  'sessions.unqueue': { params: { sessionId: string; itemId: string }; result: void }
  'sessions.steer': { params: { sessionId: string; itemId: string }; result: void }
  // Steers where the agent can; otherwise stops the turn and sends the prompt as the next one.
  'sessions.sendNow': { params: { sessionId: string; itemId: string }; result: void }
  'sessions.resumeQueue': { params: { sessionId: string }; result: void }
  // An image or pasted text the thread store keeps for a sent attachment, by its hash.
  'sessions.blob': { params: { sessionId: string; hash: string }; result: AttachmentBytes }
  'sessions.setConfigOption': {
    params: { sessionId: string; optionId: string; value: string | boolean }
    result: void
  }
  // Lists the models the agent offers now in a session that listed them when it attached.
  'sessions.refreshModels': { params: { sessionId: string }; result: void }
  // title null: back to the agent's title.
  'sessions.rename': { params: { sessionId: string; title: string | null }; result: void }
  'sessions.close': { params: { sessionId: string }; result: void }
  'sessions.pin': { params: { sessionId: string; pinned: boolean }; result: void }
  /**
   * `subSessions: false` archives the session alone, its sub-sessions staying in the list on their
   * own until it is restored; without it, its whole tree is archived.
   */
  'sessions.archive': { params: { sessionId: string; subSessions?: boolean }; result: void }
  'sessions.unarchive': { params: { sessionId: string }; result: void }
  // unread false: seen, as showing it would mark it.
  'sessions.markUnread': { params: { sessionId: string; unread: boolean }; result: void }
  'sessions.delete': { params: { sessionId: string }; result: void }
  // Once per index: the sessions left with no message go, except `keep`, those with a draft.
  'sessions.removeEmpty': { params: { keep: string[] }; result: void }
  // Messages the host kept to give back, oldest first, for a session or for New session (null);
  // with no sessionId, every one.
  'sessions.takeReturned': { params: { sessionId?: string | null }; result: ReturnedMessage[] }
  'sessions.removeAll': { params: void; result: void }
  // One of `optionId`, `answers` and `values`: a question's answers go together, only those given;
  // `values` submits an MCP server's form. `note` goes with an option that takes one.
  'permissions.respond': {
    params: {
      sessionId: string
      requestId: string
      optionId?: string
      note?: string
      answers?: QuestionAnswer[]
      values?: FormValues
    }
    result: void
  }
  // Reading the status also keeps the project live on the connection, until `git.unwatch`. A
  // client that watches a project from several screens gives each a `watcher` of its own, which
  // `git.unwatch` names, so one screen leaving leaves the others watching.
  'git.status': { params: { projectPath: string; watcher?: string }; result: GitStatus }
  'git.unwatch': { params: { projectPath: string; watcher?: string }; result: void }
  'git.fetch': { params: { projectPath: string }; result: GitOperation }
  'git.pull': { params: { projectPath: string }; result: GitOperation }
  // Publishes the branch when it has no upstream.
  'git.push': {
    params: { projectPath: string; remote: string; branch: string }
    result: GitOperation
  }
  'git.publish': {
    params: { projectPath: string; name: string; visibility: RepositoryVisibility }
    result: GitOperation
  }
  'git.createPullRequest': {
    params: { projectPath: string; title: string; body: string; base: string; draft: boolean }
    result: PullRequest
  }
  'git.commit': { params: { projectPath: string; oid: string }; result: CommitDetails }
  'git.changes': { params: { projectPath: string }; result: ChangedFile[] }
  // A commit message for the files' working tree changes, paths as `git.commitChanges` takes them,
  // written by the project's preferred agent from the diffs and the repository's recent commits.
  'git.commitMessage': { params: { projectPath: string; paths: string[] }; result: string }
  // A pull request's title and description for the branch against `base`, written by the
  // project's preferred agent from the branch's commits and files.
  'git.pullRequestDraft': {
    params: { projectPath: string; base: string }
    result: { title: string; body: string }
  }
  'git.incoming': {
    params: { projectPath: string; from: 'upstream' | 'base' }
    result: LogCommit[]
  }
  // ref null: the working tree against HEAD; otherwise the commit against its first parent.
  'git.fileDiff': {
    params: { projectPath: string; path: string; oldPath: string | null; ref: string | null }
    result: FileDiff
  }
  'git.branches': { params: { projectPath: string }; result: BranchList }
  // Switches to a local branch, or creates it from HEAD and switches to it.
  'git.switchBranch': {
    params: { projectPath: string; branch: string; create: boolean }
    result: GitOperation
  }
  // Pushes the branch, which has no upstream yet, to one of the repository's remotes and tracks it.
  'git.publishBranch': { params: { projectPath: string; remote: string }; result: GitOperation }
  // Commits the files' working tree changes, paths relative to the repository root, and nothing else.
  'git.commitChanges': {
    params: { projectPath: string; message: string; paths: string[] }
    result: GitOperation
  }
  // Puts the files back as HEAD has them; an untracked or added file is removed.
  'git.discardChanges': { params: { projectPath: string; paths: string[] }; result: GitOperation }
  'git.pullRequest': { params: { url: string }; result: PullRequest }
  // A github.com issue URL, which may turn out to be a pull request.
  'git.issue': { params: { url: string }; result: IssueLookup }
  'git.watchReferences': { params: { urls: string[] }; result: void }
  // A chip's author; null when GitHub's avatar host has no picture for the login.
  'git.avatarUrl': { params: { login: string }; result: string | null }
  'git.currentPullRequest': { params: { projectPath: string }; result: PullRequest | null }
  'git.tools': { params: void; result: GitTools }
  // Kettu's own repository through this host's gh; the repository is fixed, never a parameter.
  'star.state': { params: void; result: GitHubStarState }
  // Stars it on the user's click; false when gh could not, and the client opens the page instead.
  'star.add': { params: void; result: boolean }
  // The card or New session's line was closed.
  'star.dismiss': { params: void; result: void }
  // The repository page opened in place of a star, so the prompts end.
  'star.opened': { params: void; result: void }
  // A draft's attachment, kept until it is sent or removed; see attachments in the session model.
  // `grantId`: a file or folder main granted for a pick or a drop. `projectPath` and `path`: one
  // an `@` mention named, relative to the project and checked as `files.read` checks a path.
  'attachments.add': {
    params: {
      source:
        | { bytes: ArrayBuffer; mimeType: string; name: string }
        | { grantId: string }
        | { projectPath: string; path: string }
      thumb: string | null
    }
    result: Attachment
  }
  'attachments.read': { params: { id: string }; result: AttachmentBytes }
  // An image's thumbnail, and its bytes scaled to fit when it was too large: `scaled` null keeps them.
  'attachments.update': {
    params: {
      id: string
      thumb: string | null
      scaled: { bytes: ArrayBuffer; mimeType: string } | null
    }
    result: Attachment
  }
  'attachments.remove': { params: { id: string }; result: void }
  // The ids of these the host still holds, for the drafts that name them; each is kept from now.
  'attachments.held': { params: { ids: string[] }; result: string[] }
  'files.list': { params: { projectPath: string }; result: FileList }
  // `asText` reads a media file as any other file, as an SVG's source.
  'files.read': {
    params: { projectPath: string; path: string; asText?: boolean }
    result: FileContent
    deviceResult: DeviceFileContent
  }
  'files.search': { params: { projectPath: string; query: string }; result: FileSearch }
  // The folder where the session's agent keeps files of its own outside the project, such as agy's
  // Plan mode plan; null when it keeps none.
  'files.agentFolder': { params: { sessionId: string }; result: string | null }
  // A file of that folder, by its absolute path; read-only and never media.
  'files.readAgentFile': { params: { sessionId: string; path: string }; result: FileContent }
  // A null `version` overwrites whatever the file holds.
  'files.write': {
    params: { projectPath: string; path: string; text: string; version: string | null }
    result: FileWritten
  }
  // A new empty file or folder; the folders above it are made when missing. Never replaces one.
  'files.create': {
    params: { projectPath: string; path: string; kind: 'file' | 'folder' }
    result: void
  }
  // Renames or moves a file or folder, a link itself rather than what it points to; the folders
  // above `to` are made when missing. `conflict` when something is at `to` already.
  'files.rename': { params: { projectPath: string; from: string; to: string }; result: void }
  // Copies each into `folder` ('' is the project's), naming a copy `name copy.ext` when its name
  // is taken there; the copies' paths, in order.
  'files.copy': {
    params: { projectPath: string; paths: string[]; folder: string }
    result: string[]
  }
  // To the system's trash, or for good with `permanently`; what is gone already is skipped.
  // `unavailable` when the host could not put them in a trash.
  'files.delete': {
    params: { projectPath: string; paths: string[]; permanently?: boolean }
    result: void
  }
  // `path` as the thread writes it: absolute, `~/`, a `file:` URI, or relative to `projectPath`,
  // the session's folder. `sessionId` lets a file outside it through when that thread names it.
  'media.open': {
    params: { projectPath: string; path: string; sessionId: string }
    result: MediaOpenResult
  }
  // The same file and check for a paired device's remote host, which streams it from the real
  // path in the answer; main is granted nothing, and a window is refused. Without `sessionId`,
  // only a file in the project is let through, as for `files.read`.
  'media.authorize': {
    params: { projectPath: string; path: string; sessionId?: string }
    result: MediaAuthorization
  }
  // `dayStarts`: the periods to sum, local days or a day's hours, as n + 1 ascending boundaries.
  // `clock`: a range to sum by hour of the day as well.
  'usage.summary': {
    params: {
      dayStarts: number[]
      from: number
      to: number
      scope: UsageScope
      clock?: ClockRequest
    }
    result: UsageSummary
  }
  'usage.total': { params: { from: number; to: number }; result: UsageTotal }
  'usage.status': { params: void; result: UsageStatus }
  // Resolves once the scan is done; does nothing while Usage on this computer is off.
  'usage.sync': { params: void; result: void }
  'usage.reimport': { params: { agentId: AgentId }; result: void }
  'usage.clearRecord': { params: void; result: void }
  // Every artifact, newest first, or those in Recently deleted, the latest deletion first.
  'artifacts.list': { params: { deleted?: boolean }; result: ArtifactSummary[] }
  // The latest version without `version`.
  'artifacts.read': { params: { id: string; version?: number }; result: ArtifactContent }
  // The bytes of one file of a version, as an export takes them.
  'artifacts.file': {
    params: { id: string; version: number; path: string }
    result: { type: string; bytes: ArrayBuffer }
  }
  // Where a version's files lie on disk, for a paired device's remote host to serve them to its
  // frames; a window is refused, and the device never sees the answer.
  'artifacts.content': {
    params: { id: string; version?: number }
    result: {
      version: number
      title: string
      key: string
      strict: boolean
      files: ArtifactContentFile[]
      type?: ArtifactTypeInfo | null
    }
  }
  // Newest first.
  'artifacts.versions': { params: { id: string }; result: VersionSummary[] }
  // What changed from version `from` to `to`, any two versions, worked out from their content as
  // the shared comparison does; null when nothing did.
  'artifacts.changes': {
    params: { id: string; from: number; to: number }
    result: { changes: ArtifactChanges | null }
  }
  'artifacts.rename': { params: { id: string; title: string }; result: void }
  // Permanently only from Recently deleted.
  'artifacts.delete': { params: { id: string; permanently?: boolean }; result: void }
  'artifacts.undelete': { params: { id: string }; result: void }
  // Authored by the user; `conflict` when `baseVersion` is not the latest.
  'artifacts.restoreVersion': {
    params: { id: string; version: number; baseVersion: number }
    result: { version: number }
  }
  // Each watch counts as a viewer, and brings `artifacts.version`.
  'artifacts.watch': { params: { id: string }; result: void }
  'artifacts.unwatch': { params: { id: string }; result: void }
  // The artifact's comment threads, oldest first, anchored in its latest version.
  'artifacts.comments': { params: { id: string }; result: CommentThread[] }
  // The user's new thread; its anchor's text is what the page reported.
  'artifacts.comment': {
    params: { id: string; anchor: CommentAnchor; body: string }
    result: CommentThread
  }
  'artifacts.reply': {
    params: { id: string; threadId: string; body: string }
    result: CommentThread
  }
  'artifacts.resolve': {
    params: { id: string; threadId: string; resolved: boolean }
    result: CommentThread
  }
  // Pins the user's thread, whose element is gone, to another place of the latest version.
  'artifacts.repin': {
    params: { id: string; threadId: string; anchor: CommentAnchor }
    result: CommentThread
  }
  // The user sent the threads to a session.
  'artifacts.markSent': {
    params: { id: string; threadIds: string[]; sessionId: string }
    result: void
  }
  // The canvas page this client shows the artifact at, for the others' faces and agents' reads.
  'artifacts.view': { params: { id: string; page: string | null }; result: void }
  // A viewer of the owner's, in the main area or a side panel, has `version` open; a card in a
  // thread is no viewer. The seen version moves forward to it, never past the latest, and every
  // port hears `artifacts.seen`. The answer is the version now recorded.
  'artifacts.seen': { params: { id: string; version: number }; result: { seen: number | null } }
  // New values for the parameters a page declares, written into its file as the user's version;
  // `conflict` when the file changed since `baseVersion`.
  'artifacts.setParams': {
    params: { id: string; baseVersion: number; path: string; values: Record<string, ParamValue> }
    result: { version: number }
  }
  // The live canvas document a client works on: the latest version's, with the operations clients
  // sent since that are not yet in a version.
  'artifacts.canvas': { params: { id: string }; result: CanvasState }
  // The user's operations on a canvas, applied in the order they arrive, the last one winning per
  // property; every port showing the artifact gets them as an `artifacts.canvas` event, the sender
  // knowing its own by `client` and `clientSeq`, and they become a version once the canvas has been
  // quiet a while. An old canvas is split into the canvas format first.
  'artifacts.canvasOps': {
    params: { id: string; ops: CanvasOp[]; client: string; clientSeq: number }
    result: { seq: number }
  }
  // The user's direct edit of one element as a new version; `conflict` when the file changed since
  // `baseVersion`. `style` sets properties of its start tag's style; `text` replaces the text of an
  // element that holds text alone.
  'artifacts.editElement': {
    params: {
      id: string
      baseVersion: number
      path: string
      offset: number
      style: PreviewStyle | null
      text: string | null
    }
    result: { version: number }
  }
  // A page's message to the runtime from a frame a paired device's remote host serves, which names
  // the artifact by the frame; a window is refused. A stream's events come as `artifacts.runtime`
  // under `stream`, the port's own name for it, and the answer is its end.
  'artifacts.runtime': {
    params: { artifactId: string; message: unknown; stream?: string }
    result: RuntimeAnswer
  }
  // The user's answer to an `artifacts.consentAsked`; the first answer counts.
  'artifacts.consent': { params: { requestId: string; allow: boolean }; result: void }
  // What the user allowed which artifacts, for Settings › Artifacts.
  'artifacts.consents': { params: void; result: ArtifactConsentRow[] }
  // Takes back everything the user allowed the artifact.
  'artifacts.revokeConsent': { params: { id: string }; result: void }
  // A typed version converted on the host to one of its type's formats: one file, or Markdown with
  // its pictures under their paths. A deck's PDF is printed by a desktop app instead.
  'artifacts.export': {
    params: { id: string; version: number; format: ArtifactExportFormat }
    result: { title: string; files: { path: string; bytes: ArrayBuffer }[] }
  }
  // A desktop app's side of the browser calls the host sent its port, as main's is for the host's
  // own windows: the answer, the call's wait on a new site, and the site's question and its end,
  // which the session's thread shows. A window is refused them.
  'browser.answer': { params: { callId: number; answer: BrowserCallAnswer }; result: void }
  'browser.waiting': { params: { callId: number; waiting: boolean }; result: void }
  'browser.origin': {
    params: { sessionId: string; requestId: number; origin: string }
    result: void
  }
  'browser.originSettled': {
    params: { requestId: number; decision: BrowserOriginAnswer }
    result: void
  }
  // The desktop app's user handed its page back after taking it over in the session's turn.
  'browser.handedBack': { params: { sessionId: string; durationMs: number }; result: void }
  // Any window's or device's Done or Skip on the card of a step an agent asked the user to do,
  // which goes to the page; the first counts.
  'control.answerAsk': {
    params: { sessionId: string; entryId: string; outcome: ControlOutcome }
    result: void
  }
  // Any window's or device's answer to a new site's card, `entryId`, which goes to the page that
  // asked; the first counts, as for `permissions.respond`.
  'browser.answerOrigin': {
    params: { sessionId: string; entryId: string; decision: BrowserOriginDecision }
    result: void
  }
  // Any window's or device's answer to a mobile device card; the first counts.
  'devices.answerAccess': {
    params: { sessionId: string; entryId: string; decision: DeviceAccessDecision }
    result: void
  }
  // Any window's or device's answer to a card asking whether the agent may use a terminal or a
  // browser tab the user opened, or rename a terminal of theirs; the first counts.
  'surfaces.answerAccess': {
    params: { sessionId: string; entryId: string; decision: SurfaceAccessDecision }
    result: void
  }
  // Takes back the use of a terminal the user opened from the session's agent, which asks again.
  'terminals.revokeAccess': { params: { sessionId: string; terminalId: string }; result: void }
  // Takes back the allow a session's agent has for a device, so its next use asks again.
  'devices.revokeAccess': { params: { sessionId: string; deviceId: string }; result: void }
  // The mobile devices agents may always use on this host, and taking one off that list.
  'devices.allowed': { params: Record<string, never>; result: { deviceIds: string[] } }
  'devices.forget': { params: { deviceId: string }; result: void }
  // Any window's or device's answer to a session's first use of an app, `entryId`, which goes to
  // the call that asked; the first counts, as for `permissions.respond`.
  'computer.answerApp': {
    params: { sessionId: string; entryId: string; decision: ComputerAppDecision }
    result: void
  }
  // Any window's or device's answer to a card holding the MCP servers a session's folder declares
  // itself; the first counts, as for `permissions.respond`, and settles the folder's other cards.
  'sessions.answerProjectMcp': {
    params: { sessionId: string; entryId: string; decision: ProjectMcpDecision }
    result: void
  }
  // The same for a card holding the hooks a session's folder declares in its own settings.
  'sessions.answerProjectHooks': {
    params: { sessionId: string; entryId: string; decision: ProjectHooksDecision }
    result: void
  }
  // What became of a problem report the agent drafted, from the window or device that sent, saved
  // or dropped it; the first answer counts.
  'sessions.answerReport': {
    params: { sessionId: string; entryId: string; outcome: ProblemReportOutcome }
    result: void
  }
  // The answer to an agent's proposed write to global memory, from the window or device that gave
  // it first; `remember` writes it.
  'sessions.answerMemory': {
    params: { sessionId: string; entryId: string; decision: MemoryDecision }
    result: void
  }
  // Takes an agent's project memory write back, while the entry is as that write left it.
  'sessions.undoMemory': {
    params: { sessionId: string; entryId: string }
    result: void
  }
  // Settings › Memory: the switch, global memory, the projects with their counts, and how many
  // entries the agents' own memories hold that could be imported.
  'memory.overview': { params: void; result: MemoryOverview }
  'memory.list': { params: { scope: MemoryScope }; result: MemoryEntry[] }
  // Writes the user's entry: a new one when `id` is null, else that entry changed.
  'memory.save': {
    params: { scope: MemoryScope; id: string | null; draft: MemoryDraft }
    result: MemoryEntry
  }
  'memory.remove': { params: { scope: MemoryScope; id: string }; result: void }
  // Moves a project's entry to global memory; the user asking is the consent global writes need.
  'memory.moveToGlobal': { params: { project: string; id: string }; result: MemoryEntry }
  // Off: no index and no memory tools, and each harness keeps its own memory as it had it.
  'memory.setEnabled': { params: { enabled: boolean }; result: void }
  // What the agents' own memories hold for projects Kettu knows, not yet imported.
  'memory.importScan': { params: void; result: MemoryImportScan }
  // Copies those sources into their projects' memory; `global` names the entries the user ticked
  // to go to global memory instead. The originals stay as they are.
  'memory.import': {
    params: { sources: { agentId: AgentId; project: string }[]; global: string[] }
    result: MemoryImportResult
  }
  // The label's Stop using: the session stops using the computer for the rest of its turn.
  'computer.stop': {
    params: { sessionId: string }
    result: void
  }
  // Take over: the user holds the app the session uses, and its calls wait until Hand back.
  'computer.takeOver': {
    params: { sessionId: string }
    result: void
  }
  'computer.handBack': {
    params: { sessionId: string }
    result: void
  }
  // Show app: brings the window the session uses to the front; from this computer's windows only.
  'computer.show': {
    params: { sessionId: string }
    result: void
  }
  // Not now on a setup card, `entryId`, from any window or device: the call that waits on it fails.
  'computer.declineSetup': {
    params: { sessionId: string; entryId: string }
    result: void
  }
}

export type HostMethod = keyof HostContract
export type HostParams<M extends HostMethod> = HostContract[M]['params']
export type HostResult<M extends HostMethod> = HostContract[M]['result']
/** What a paired device's port gets: a method's `deviceResult` where it has one, else its result. */
export type DeviceResult<M extends HostMethod> = HostContract[M] extends { deviceResult: infer R }
  ? R
  : HostResult<M>

/**
 * The methods that managed Claude Code's and Codex's plugins, which Kettu no longer does. A host
 * answers them with an error that says so.
 */
export const REMOVED_PLUGIN_METHODS = [
  'market.plugins',
  'market.pluginDetails',
  'market.pluginLogo',
  'market.installPlugin',
  'market.uninstallPlugin',
  'market.setPluginEnabled',
  'market.addMarketplace',
  'market.removeMarketplace',
  'market.installCommunityPlugin',
] as const

export const HOST_METHODS = [
  'agents.list',
  'agents.check',
  'agents.reloadEnvironment',
  'agents.detectedPrograms',
  'agents.environment',
  'agents.authenticate',
  'agents.cancelSignIn',
  'agents.logout',
  'agents.providerAction',
  'agents.retry',
  'agents.reinstall',
  'agents.checkUpdates',
  'agents.skipUpdate',
  'agents.unskipUpdate',
  'agents.update',
  'agents.updateCli',
  'agents.setApiKey',
  'agents.clearApiKey',
  'agents.install',
  'agents.installOffer',
  'agents.uninstall',
  'agents.cancelTask',
  'agents.readOptions',
  'agents.readFirstOptions',
  'agents.refreshLimits',
  'agents.spendReset',
  'agents.details',
  'agents.claudeSettings',
  'agents.setClaudeSetting',
  'agents.autoCompact',
  'agents.setAutoCompact',
  'agents.codebuddySettings',
  'agents.setCodebuddySite',
  'agents.refreshAccount',
  'agents.listSessions',
  'agents.options',
  'agents.pinModel',
  'agents.lightAgents',
  'agents.draftReport',
  'mcp.status',
  'mcp.retry',
  'market.catalog',
  'market.search',
  'market.keys',
  'market.connect',
  'market.detectSignIn',
  'market.cancelConnect',
  'market.disconnect',
  'market.connections',
  'market.ownPlugins',
  'market.skills',
  'market.skillRepository',
  'market.addSkill',
  'market.answerPublish',
  'settings.answerChange',
  'settings.undoChange',
  'market.publishDrafts',
  'market.discardPublishDraft',
  'market.community',
  'market.communityListing',
  'market.communityWorkflow',
  'market.communityInstalled',
  'market.addCommunityWorkflow',
  'market.reportCommunity',
  'market.bundlePrepare',
  'market.bundleCommit',
  'market.bundleCancel',
  'market.account',
  'market.published',
  'market.setPublisher',
  'market.updateListing',
  'market.withdrawVersion',
  'market.deleteListing',
  'market.versionFiles',
  'market.checkFolder',
  'market.convertFolder',
  'market.convertListing',
  'market.publishFolder',
  'projects.list',
  'projects.add',
  'projects.remove',
  'projects.touch',
  'projects.pin',
  'projects.move',
  'projects.noProject',
  'projects.worktreeSettings',
  'projects.setWorktreeSettings',
  'paths.complete',
  'sessions.list',
  'sessions.create',
  'sessions.prepare',
  'sessions.discard',
  'sessions.import',
  'sessions.open',
  'sessions.snapshot',
  'sessions.page',
  'sessions.entry',
  'sessions.requests',
  'sessions.outline',
  'sessions.modelRequests',
  'sessions.modelRequestsOverview',
  'sessions.modelRequestRaw',
  'sessions.search',
  'sessions.find',
  'sessions.outputs',
  'sessions.outlineTitles',
  'sessions.watch',
  'sessions.unwatch',
  'sessions.show',
  'sessions.prompt',
  'sessions.attachEarly',
  'sessions.cancel',
  'sessions.runningWork',
  'sessions.idleRelease',
  'host.load.watch',
  'host.load.unwatch',
  'sessions.stopTask',
  'sessions.taskOutput',
  'sessions.sideAsk',
  'sessions.sideStop',
  'sessions.sideClear',
  'sessions.sideAgents',
  'sessions.retry',
  'sessions.cancelContinue',
  'sessions.rewind',
  'sessions.putBack',
  'sessions.fork',
  'worktrees.inspect',
  'worktrees.remove',
  'worktrees.retrySetup',
  'worktrees.skipSetup',
  'worktrees.setupLog',
  'sessions.switchAgent',
  'sessions.context',
  'sessions.contextEstimates',
  'sessions.queue',
  'sessions.runCommand',
  'sessions.unqueue',
  'sessions.steer',
  'sessions.sendNow',
  'sessions.resumeQueue',
  'sessions.blob',
  'sessions.setConfigOption',
  'sessions.refreshModels',
  'sessions.rename',
  'sessions.close',
  'sessions.pin',
  'sessions.archive',
  'sessions.unarchive',
  'sessions.markUnread',
  'sessions.delete',
  'sessions.removeEmpty',
  'sessions.takeReturned',
  'sessions.removeAll',
  'routines.list',
  'routines.create',
  'routines.update',
  'routines.delete',
  'routines.runNow',
  'routines.cancelRun',
  'routines.runs',
  'routines.markSeen',
  'plugins.list',
  'plugins.inspect',
  'plugins.install',
  'plugins.discard',
  'plugins.uninstall',
  'plugins.setEnabled',
  'plugins.setSetting',
  'plugins.setSecret',
  'plugins.setChannelKinds',
  'plugins.reload',
  'plugins.checkUpdates',
  'plugins.applyUpdate',
  'plugins.declineUpdate',
  'plugins.rollBack',
  'plugins.viewData',
  'plugins.viewAction',
  'plugins.actionRun',
  'plugins.refs',
  'plugins.mentionSearch',
  'plugins.linkCard',
  'plugins.resources',
  'commands.list',
  'roles.list',
  'workflows.list',
  'workflows.read',
  'workflows.add',
  'workflows.update',
  'workflows.approve',
  'workflows.remove',
  'workflows.pin',
  'workflows.settings',
  'workflows.setSettings',
  'workflows.suggestions',
  'workflows.suggestionFile',
  'workflows.answerSuggestion',
  'tasks.list',
  'tasks.get',
  'tasks.sessions',
  'tasks.start',
  'tasks.review',
  'tasks.answer',
  'tasks.retry',
  'tasks.cancel',
  'tasks.delete',
  'tasks.note',
  'tasks.pin',
  'tasks.update',
  'tasks.saveWorkflow',
  'tasks.publishWorkflow',
  'permissions.respond',
  'git.status',
  'git.unwatch',
  'git.fetch',
  'git.pull',
  'git.push',
  'git.publish',
  'git.createPullRequest',
  'git.commit',
  'git.changes',
  'git.commitMessage',
  'git.pullRequestDraft',
  'git.incoming',
  'git.fileDiff',
  'git.branches',
  'git.switchBranch',
  'git.publishBranch',
  'git.commitChanges',
  'git.discardChanges',
  'git.pullRequest',
  'git.issue',
  'git.watchReferences',
  'git.avatarUrl',
  'git.currentPullRequest',
  'git.tools',
  'star.state',
  'star.add',
  'star.dismiss',
  'star.opened',
  'attachments.add',
  'attachments.read',
  'attachments.update',
  'attachments.remove',
  'attachments.held',
  'files.list',
  'files.read',
  'files.search',
  'files.agentFolder',
  'files.readAgentFile',
  'files.write',
  'files.create',
  'files.rename',
  'files.copy',
  'files.delete',
  'media.open',
  'media.authorize',
  'usage.summary',
  'usage.total',
  'usage.status',
  'usage.sync',
  'usage.reimport',
  'usage.clearRecord',
  'artifacts.list',
  'artifacts.read',
  'artifacts.file',
  'artifacts.content',
  'artifacts.versions',
  'artifacts.changes',
  'artifacts.rename',
  'artifacts.delete',
  'artifacts.undelete',
  'artifacts.restoreVersion',
  'artifacts.watch',
  'artifacts.unwatch',
  'artifacts.comments',
  'artifacts.comment',
  'artifacts.reply',
  'artifacts.resolve',
  'artifacts.markSent',
  'artifacts.repin',
  'artifacts.editElement',
  'artifacts.view',
  'artifacts.seen',
  'artifacts.setParams',
  'artifacts.canvas',
  'artifacts.canvasOps',
  'artifacts.runtime',
  'artifacts.consent',
  'artifacts.consents',
  'artifacts.revokeConsent',
  'artifacts.export',
  'browser.answer',
  'browser.waiting',
  'browser.origin',
  'browser.originSettled',
  'browser.handedBack',
  'control.answerAsk',
  'browser.answerOrigin',
  'devices.answerAccess',
  'devices.revokeAccess',
  'surfaces.answerAccess',
  'terminals.revokeAccess',
  'devices.allowed',
  'devices.forget',
  'computer.answerApp',
  'sessions.answerProjectMcp',
  'sessions.answerProjectHooks',
  'sessions.answerReport',
  'sessions.answerMemory',
  'sessions.undoMemory',
  'memory.overview',
  'memory.list',
  'memory.save',
  'memory.remove',
  'memory.moveToGlobal',
  'memory.setEnabled',
  'memory.importScan',
  'memory.import',
  'computer.stop',
  'computer.takeOver',
  'computer.handBack',
  'computer.show',
  'computer.declineSetup',
] as const satisfies readonly HostMethod[]

/** One that has a session in front: the host's own windows as one, or a paired device. */
export type SessionViewer = { kind: 'host' } | { kind: 'device'; id: string; name: string }

export type HostEvent =
  | { type: 'session.patches'; batch: PatchBatch }
  | { type: 'session.summary'; summary: SessionSummary }
  | { type: 'session.removed'; sessionId: string }
  | { type: 'session.returned'; sessionId: string | null }
  // To a port that watches the session: the others that have it in front, never the port's own
  // computer or device.
  | { type: 'session.viewers'; sessionId: string; viewers: SessionViewer[] }
  | { type: 'agent.status'; status: AgentStatus }
  | { type: 'agent.removed'; agentId: AgentId }
  | { type: 'agent.options'; options: AgentOptions }
  // To the port whose `agents.authenticate` runs: the agent's sign-in page, for its device to open.
  | { type: 'agents.signInLink'; agentId: AgentId; url: string }
  // `noProject` is absent from hosts that cannot pin No project.
  | { type: 'projects.changed'; projects: Project[]; noProject?: NoProject }
  | { type: 'environment.changed'; info: EnvironmentInfo }
  | { type: 'git.changed'; status: GitStatus }
  | { type: 'git.pr'; projectPath: string; pr: PullRequest | null }
  | { type: 'git.reference'; url: string; found: IssueLookup } // to the ports watching `url`
  | { type: 'git.tools'; tools: GitTools }
  | { type: 'star.changed'; state: GitHubStarState }
  | { type: 'usage.changed' } // the figures changed; a page showing them reads again
  | { type: 'market.keysChanged' } // the Marketplace's keys changed; a page showing them reads again
  // The account, what it published or the drafts changed; Marketplace › Published reads again.
  | { type: 'market.publishedChanged' }
  // To the windows showing a session: its agent's open_settings, Settings at a row.
  | { type: 'settings.open'; section: SettingsSection; item: string | null; row: string }
  | { type: 'plugins.changed' } // an installed plugin changed; a page showing them reads again
  | { type: 'memory.changed' } // Kettu's memory or its switch changed; a page showing it reads again
  // A server's sign-in changed; `loginId` and `error` close a Connect the window started.
  | {
      type: 'market.connectionChanged'
      serverId: string
      connection: MarketConnection
      loginId?: string
      error?: string
    }
  | { type: 'usage.status'; status: UsageStatus }
  | { type: 'idleRelease.changed'; state: IdleReleaseState }
  // To a port watching the host's load: the reading.
  | { type: 'host.load'; load: HostLoad }
  | { type: 'artifacts.changed' } // the list changed; a page showing it reads again
  | { type: 'artifacts.version'; id: string; version: number }
  // To every port: the owner's seen version of the artifact moved, as `artifacts.seen` recorded it.
  | { type: 'artifacts.seen'; id: string; version: number }
  // `clients` are the other clients showing it, as `session.viewers` names them for the receiver.
  | {
      type: 'artifacts.activity'
      id: string
      viewers: number
      clients: Array<SessionViewer & { page: string | null }>
      sessions: ArtifactSession[]
    }
  // To the ports watching the artifact: its comments changed, so they read them again.
  | { type: 'artifacts.comments'; id: string }
  // To the ports watching a canvas: operations in the order they applied, or its document again.
  | ({ type: 'artifacts.canvas' } & CanvasEvent)
  // A stream's event or end, to the port that asked under `stream`.
  | { type: 'artifacts.runtime'; stream: string; answer: RuntimeAnswer }
  // To the ports showing the artifact on the client a page asked from: the user's consent, asked
  // outside the page. `settled` ends it everywhere; `reload` when the page stopped waiting before
  // the user allowed it, so the page loads again to use what it may now.
  | { type: 'artifacts.consentAsked'; ask: ArtifactConsentAsk }
  | { type: 'artifacts.consentSettled'; requestId: string; artifactId: string; reload: boolean }
  // What Settings › Artifacts lists changed.
  | { type: 'artifacts.consentsChanged' }
  | { type: 'routine.changed'; routine: RoutineView } // a routine, its state or its next run
  | { type: 'routine.removed'; routineId: string }
  | { type: 'task.changed'; task: TaskView }
  | { type: 'task.removed'; taskId: string }
  | { type: 'workflows.changed' } // the workflow library or its settings changed; a page showing it reads again
  | { type: 'workflows.suggestion'; suggestion: WorkflowSuggestion } // a card's answer or Start's progress
  | { type: 'routine.run'; run: RoutineRun } // a run's status changed
  // To the port of the desktop app that sent the turn: a call for its main to run on the session's
  // page, answered by `browser.answer`.
  | { type: 'browser.call'; call: BrowserDeviceCall }
  // To that port: the answer a window or device gave its page's new site, for its main to give.
  | {
      type: 'browser.originDecided'
      sessionId: string
      requestId: number
      decision: BrowserOriginDecision
    }
  // To that port: the last running turn that used the session's page ended.
  | { type: 'browser.turnEnded'; sessionId: string }
  // To that port: Done or Skip on the card of the step the agent asked for on the page.
  | { type: 'browser.askAnswered'; sessionId: string; outcome: ControlOutcome }

export interface AgentsApi {
  request<M extends HostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>>
  onEvent(listener: (event: HostEvent) => void): () => void
  /** Calls the listener with the current state, if there is one yet, and then on every change. */
  onConnection(listener: (state: PortConnectionState) => void): () => void
  /** Starts the host again after it failed (crashed too often); does nothing otherwise. */
  restart(): Promise<void>
}
