// The agent host, assembled: state, agents, sessions, git and the ports. start.ts runs it in
// the utility process or under Node.js; tests run it in-process with fakes for the launcher,
// shell and git.

import { DEVICE_ACCESS_WAIT_MS, type DeviceCall, type DeviceCallAnswer } from '@shared/device-agent'
import {
  replyRunNotice,
  type TerminalCall,
  type TerminalCallAnswer,
  type TerminalCallErrorCode,
} from '@shared/terminal-agent'
import { DeviceAccessStore } from './devices/access'
import os from 'node:os'
import path from 'node:path'
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import type {
  AgentOptions,
  AgentStatus,
  DiagnosticsBundle,
  HostEvent,
  HostParams,
  McpStatus,
} from '@shared/agent-host'
import { OWNER } from '@shared/artifact-comments'
import { flushLog, logFolder, redactLogText, writeLog } from '@shared/log/process-log'
import { channelTrigger, PLUGIN_CHANNEL_EVENT } from '@shared/plugin-channels'
import { PLUGIN_THEMES_FILE } from '@shared/plugin-themes'
import type { AgentToPluginHost } from '@shared/plugin-host'
import { pluginText, type InstalledKettuPlugin } from '@shared/plugins'
import { toolId, type CatalogPlugin } from '@shared/settings-catalog'
import { writeReport } from '@shared/log/report-bundle'
import { parseReportRequest } from '@shared/report'
import { harnessOf, takesStartMode, type HarnessId } from '@shared/agents'
import type { RuntimeAnswer } from '@shared/artifact-capabilities'
import { ARTIFACT_ENTRY, artifactFileType } from '@shared/artifact-files'
import { type ArtifactImportResult, type ArtifactSummary, NO_SESSION } from '@shared/artifacts'
import type { AttachmentGrant } from '@shared/attachments'
import {
  siteOf,
  type BrowserCallAnswer,
  type BrowserCallRequest,
  type BrowserOriginAnswer,
} from '@shared/browser'
import { isControlOutcome, isControlStep, SURFACE_ACCESS_WAIT_MS } from '@shared/control'
import type {
  AgentProcess,
  AttentionFront,
  ArtifactBrief,
  ArtifactContentResult,
  ArtifactExportResult,
  ArtifactListResult,
  ComputerControlAction,
  HostToMain,
  MainToHost,
  NodeRuntime,
  ReportBuildResult,
  SettingFacts,
  SettingsCall,
  SettingsCallAnswer,
  SettingsSnapshot,
} from '@shared/host-control'
import type { ArtifactExportFormat } from '@shared/artifact-types'
import type { ComputerFrame } from '@shared/computer-use'
import type { Platform } from '@shared/platform'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort, PortErrorCode } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import type { MemorySource } from '@shared/memory'
import type { HostSettings } from '@shared/settings'
import {
  serverFor,
  serverName,
  specInputs,
  type CatalogServer,
  type MarketConnection,
  type MarketServer,
  type MarketSkill,
} from '@shared/marketplace'
import { listingIdOf } from '@shared/market-community'
import {
  HANDLE,
  MARKET_WAIT_MS,
  type MarketAccount,
  type MarketCall,
  type MarketCallAnswer,
  type MarketResults,
} from '@shared/market-publish'
import { HARNESSES_FOLDER, KETTU_HOME_FOLDER } from '@shared/storage'
import type {
  AgentId,
  DigestedThreadEntry,
  FromDevice,
  ThreadEntry,
  UserContent,
} from '@shared/thread'
import { AgentFiles } from './agent-files'
import { agentOptionsFile, AgentOptionsStore, startModeIn } from './agent-options'
import { listedModels } from './claude/user-settings'
import { STOP_TIMINGS } from './agent-process'
import { AgentTrees } from './agent-trees'
import { readImport } from './artifacts/import'
import { PluginTemplates } from './artifacts/plugin-templates'
import { ArtifactConsents } from './artifacts/runtime/consent'
import type { DeclaredArtifact } from './artifacts/runtime/calls'
import { ArtifactData } from './artifacts/runtime/data'
import { dbCapability } from './artifacts/runtime/db-capability'
import {
  CapabilityError,
  registerCapability,
  RuntimeDispatcher,
  RuntimeRequests,
} from './artifacts/runtime/dispatcher'
import { filesCapability } from './artifacts/runtime/files-capability'
import {
  sampleCapability,
  type SampleAgent,
  type SampleQuestion,
} from './artifacts/runtime/sample-capability'
import { ArtifactService, SERVICE_NAME } from './artifacts/service'
import { ArtifactError, ArtifactStore, versionSummary } from './artifacts/store'
import { registerContentCapability } from './artifacts/types/capability'
import { ExportError, exportVersion } from './artifacts/types/export'
import { ArtifactTypes } from './artifacts/types/registry'
import { upgradeContent } from './artifacts/types/writes'
import {
  AgentManager,
  processLauncher,
  type AgentLauncher,
  type AgentManagerDeps,
  type AgentTimings,
} from './agents'
import { buildCatalog, configFolders, type AgentDefinition } from './catalog'
import {
  answerOf,
  BROWSER_GONE,
  browserTarget,
  DeviceBrowserCalls,
  type BrowserTarget,
} from './device-browser'
import { BrowserTurns } from './browser-turns'
import { writeCommitMessage } from './commit-message'
import { writePullRequestDraft } from './pull-request-draft'
import { lightTarget } from './light-model'
import { reportDraftPrompt, writeReportDraft } from './report-draft'
import { Diagnostics } from './diagnostics'
import { HostError, invalidParams, notFound } from './errors'
import { setLocale, t, tSettings, tSettingsEnglish } from './i18n'
import { FilesService } from './files'
import { MediaService } from './media'
import { MemoryError, type MemoryErrorCode } from './memory/errors'
import { MemoryService } from './memory/service'
import { catalogFile, MarketCatalogService } from './marketplace/catalog'
import { bundlesFile, MarketBundlesService } from './marketplace/bundles'
import { MarketCommunityService } from './marketplace/community'
import { MarketConnectionsService } from './marketplace/connections'
import { logText } from './localized-error'
import { parseSignIns } from './marketplace/oauth'
import { McpProxy } from './marketplace/proxy'
import type { CodexRequest } from './codex/rpc'
import { OwnPluginsService } from './marketplace/own-plugins'
import { MarketSkillsService, skillFor, skillsCatalogFile } from './marketplace/skills'
import { CommandsService } from './commands/service'
import { RolesService } from './roles/service'
import { PluginsService } from './plugins/service'
import { PluginThemeIndex } from './plugins/theme-index'
import { pluginsFile as kettuPluginsFile } from './plugins/store'
import { PublishDrafts } from './marketplace/publish-drafts'
import { PluginConverter } from './marketplace/plugin-conversions'
import { MarketCallError, MarketTools } from './marketplace/publish-tools'
import {
  SETTINGS_WAIT_MS,
  SettingsTools,
  StaleUndo,
  type LocalFacts,
  type SettingsTarget,
} from './settings/tools'
import {
  ALL_TRANSPORTS,
  keyState,
  libraryServers,
  parseMarketKeys,
  serverHeaders,
  type MarketKeys,
} from './marketplace/servers'
import { findCommand, isExecutableFile, type Env } from './find-command'
import type { GitServiceApi, GitServiceDeps } from './git/api'
import { createExec, type ExecRunner } from './git/exec'
import { GitRetains } from './git/retains'
import type { SkillsListResponse } from './codex/protocol'
import { completePath } from './path-completion'
import { pathKey } from './paths'
import { PluginChannels } from './plugin-runtime/channels'
import { PluginHostClient } from './plugin-runtime/client'
import { PluginHooks, type RequestFacts } from './plugin-runtime/hooks'
import { InstalledScripts } from './plugin-runtime/installed'
import { PluginRefs } from './plugin-runtime/refs'
import { PluginViews } from './plugin-runtime/views'
import { createPluginApi, type ColorMode, type PLUGIN_EVENTS } from './plugin-runtime/functions'
import { PluginStorage } from './plugin-runtime/storage'
import { PluginTools } from './plugin-runtime/tools'
import { PreparedRecords, preparedFile, settingsTargets } from './prepared'
import { processControl, type ProcessControl } from './process-tree'
import { ProjectHooksAnswers } from './project-hooks'
import { ProjectMcpAnswers } from './project-mcp'
import { Projects } from './projects'
import { claudeOutside, type OutsideReader } from './outside-sessions'
import { claudeCacheTtl, type CacheTtlReader } from './prompt-cache'
import { claudeModelRequests } from './model-requests/claude'
import { clineModelRequests } from './model-requests/cline'
import { codexModelRequests } from './model-requests/codex'
import { opencodeModelRequests } from './model-requests/opencode'
import { byHarness } from './model-requests/reader'
import { AcpMessages, acpModelRequests } from './model-requests/acp-messages'
import { IdleRelease } from './idle-release'
import { LoadMonitor } from './load/monitor'
import { SystemReader } from './load/system'
import { PortHub, type Handlers, type RequestContext } from './rpc'
import { Attachments, toArrayBuffer } from './attachments'
import { RoutinesManager, type RoutineTimings } from './routines/manager'
import { TaskEngine, type TaskSessionHooksRef, type WrittenDocument } from './workflow/engine'
import {
  keptTool,
  type SuggestedTool,
  type WorkflowSettings,
  type TaskSummary,
  type TaskView,
  type WorkflowEntry,
} from '@shared/workflow'
import { STEP_HARNESSES } from './workflow/picks'
import { createTaskGit } from './workflow/git'
import { optionsOfPick, pickOfOptions, workflowAgents } from './workflow/host-agents'
import { WorkflowLibrary, workflowsFile } from './workflow/library'
import { WorkflowSuggestions, suggestionsFile } from './workflow/suggestions'
import { publishWorkflowPrompt } from './workflow/prompts'
import { deliveryOf } from './workflow/views'
import type { RoutineSessionHooksRef } from './routines/hooks'
import type { RoutineClock } from './routines/scheduler'
import { ScratchFolders } from './scratch'
import { createWorktreeGit } from './worktrees/git'
import { WorktreeManager } from './worktrees/manager'
import { ComputerDriver, probePermissions } from './computer/driver'
import { ComputerUse } from './computer/service'
import { SessionFiles } from './session-files'
import { SessionManager, type SessionTimings } from './sessions'
import { EnvironmentService, type EnvironmentServiceDeps } from './shell-env'
import {
  agentProcessesFile,
  agentsFile,
  agentUpdatesFile,
  projectsFile,
  projectHooksFile,
  projectMcpFile,
  registryListingFile,
  harnessManifestFile,
  returnedFile,
  routinesFile,
  sessionsFile,
  type AgentsFile,
  type AgentUpdatesFile,
  type JsonFile,
  type RegistryListingFile,
  type HarnessManifestFile,
} from './storage'
import { GitHubStar, gitHubStarFile } from './github-star'
import { digestEntries } from './threads/digest'
import type { ImageMode } from './threads/model'
import { ThreadStore, type ThreadWorkerFactory } from './threads/store'
import { UsageManager, type UsageTimings } from './usage/manager'
import type { LogReader } from './usage/model'
import { LimitNotices, limitNoticeText, type LimitNotice } from './limit-notices'
import { LOG_READERS } from './usage/readers'
import { UsageStore, type UsageWorkerFactory } from './usage/store'
import { createValidators } from './validate'

// The agent menu reads a running agent's options again once they are older than this.
const OPTIONS_FRESH_MS = 5 * 60_000
/** How long a used-up window's notice waits for the turn it stopped to fail. */
const LIMIT_MERGE_MS = 2_000
/** A turn that failed this long before its window was used up counts as stopped by it. */
const LIMIT_FAILED_WITHIN_MS = 15_000
/** The harnesses whose connection answers a page's question in a session with no tools at all. */
const QUESTION_HARNESSES: ReadonlySet<HarnessId> = new Set(['claude-code'])

/** Refuses a port that is not a desktop app's: only one runs browser calls for the host. */
function browserApp(ctx: RequestContext): void {
  if (!ctx.device?.browser) {
    throw new HostError('forbidden', 'Only a paired desktop app answers browser calls')
  }
}

function brief(
  artifact: Pick<ArtifactSummary, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  deleted: boolean,
): ArtifactBrief {
  const { id, version, createdAt, updatedAt } = artifact
  return { id, version, createdAt, updatedAt, deleted }
}

/** A window, and a device that said so, read stored images by hash; other devices get bytes. */
function imagesFor(device: PortDevice | null): ImageMode {
  return device && !device.imageRefs ? 'inline' : 'refs'
}

/** A page as a device reads it: with long tool outputs and inputs as digests, when it said so. */
function digestsFor<T extends { entries: ThreadEntry[] }>(
  device: PortDevice | null,
  page: T,
): T | (Omit<T, 'entries'> & { entries: DigestedThreadEntry[] }) {
  return device?.toolDigests ? digestEntries(page) : page
}

/** What a message or answer from a paired device's port keeps of it; none from a window. */
function fromDevice(device: PortDevice | null): FromDevice | undefined {
  return device ? { id: device.id, name: device.name } : undefined
}

/** The user's own writes to Kettu's memory, from Settings, name no agent or session. */
const BY_USER: MemorySource = { agentId: null, sessionId: null }

const MEMORY_ERRORS: Record<MemoryErrorCode, PortErrorCode> = {
  invalid: 'invalid_params',
  secret: 'invalid_params',
  full: 'conflict',
  not_found: 'not_found',
  conflict: 'conflict',
  off: 'unavailable',
}

/** Runs a memory request, its refusals crossing the port with `memory_<code>` as `data.reason`. */
async function memoryCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error
    throw new HostError(MEMORY_ERRORS[error.code], error.message, {
      reason: `memory_${error.code}`,
    })
  }
}

export interface HostOptions {
  userDataPath: string
  appVersion: string
  platform: Platform
  nodeRuntime: NodeRuntime
  fakeAgentPath: string | null
  /** The session router's bundle, which a per-session agent's process runs under. */
  sessionRouterPath?: string | null
  /** The bundle of the process that runs Cline's SDK; without it Cline runs over ACP. */
  clineHostPath?: string | null
  settings: HostSettings
  baseEnv: Env
  send(message: HostToMain): void
  /** The git service, or how to make one with the host's log; without it every `git.*` fails. */
  git?: GitServiceApi | ((deps: GitServiceDeps) => GitServiceApi) | null
  launcher?: AgentLauncher
  resolveEnv?: EnvironmentServiceDeps['resolve']
  probeNode?: EnvironmentServiceDeps['probe']
  detect?: AgentManagerDeps['detect']
  /** Each agent's protocol over the catalog's, as a test runs the fake ACP agent under its id. */
  protocols?: AgentManagerDeps['protocols']
  /** Drivers over the built-in ones, as a test's own. */
  drivers?: AgentManagerDeps['drivers']
  agentTimings?: Partial<AgentTimings>
  sessionTimings?: Partial<SessionTimings>
  /** How long a minute of a run's time limit lasts, shortened by tests. */
  routineTimings?: Partial<RoutineTimings>
  /** The scheduler's clock and timer; the system's by default, or a test's. */
  routineClock?: RoutineClock
  /** How long after an agent's traffic its process tree is listed again. */
  treeNoteMs?: number
  /** Lists and stops the agents' process trees; the system's tools by default. */
  processControl?: ProcessControl
  mirrorTraffic?: boolean
  /** Starts the worker that owns the thread database; without it no thread is stored. */
  threadWorker?: ThreadWorkerFactory
  /** Starts the worker that owns the usage database; without it no usage is kept. */
  usageWorker?: UsageWorkerFactory
  usageTimings?: Partial<UsageTimings>
  /** The agents' log readers, for the manager; the worker has its own. */
  usageReaders?: readonly LogReader[]
  /** Where the agents' logs are looked for; the user's home by default. */
  homeDir?: string
  /** Where harness packages are installed; `~/.kettu/harnesses` by default, which apps share. */
  harnessesDir?: string
  /** Reads a session's prompt cache lifetime; Claude Code's transcripts by default. */
  cacheTtl?: CacheTtlReader
  /** Reads Claude Code sessions run outside Kettu; tests pass their own. */
  outside?: OutsideReader
  /** The desktop app's computer use; the daemon has none. */
  computer?: ComputerHostOptions | null
  /** What the host's requests to Kettu's download service say they are: the app or the daemon. */
  userAgent?: string
}

/** What the desktop app gives the host for computer use. */
export interface ComputerHostOptions {
  /** The `cua-driver` program in the app's resources, which may be missing in a checkout. */
  driverPath: string
  /** Kettu's own process and app ids, which computer use never touches. */
  selfPid: number
  selfIds: string[]
}

/** Whether a path is a directory, without raising when it is not there. */
async function isDirectory(folder: string): Promise<boolean> {
  return (await stat(folder).catch(() => null))?.isDirectory() ?? false
}

/**
 * Kettu used to install harness packages beside its own data, where uninstalling the app could
 * take them along. Moves that folder to the user's home once; a folder on another volume is
 * copied instead.
 */
async function moveHarnessInstalls(
  legacy: string,
  target: string,
  log: (message: string) => void,
): Promise<void> {
  if (!(await isDirectory(legacy)) || (await isDirectory(target))) return
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await rename(legacy, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      log(`Could not move ${legacy} to ${target}: ${(error as Error).message}`)
      return
    }
    try {
      await cp(legacy, target, { recursive: true })
      await rm(legacy, { recursive: true, force: true })
    } catch (copyError) {
      log(`Could not move ${legacy} to ${target}: ${(copyError as Error).message}`)
    }
  }
}

function harnessesFolder(options: HostOptions): string {
  return (
    options.harnessesDir ??
    path.join(options.homeDir ?? os.homedir(), KETTU_HOME_FOLDER, HARNESSES_FOLDER)
  )
}

const REPLY_RUN_ERRORS: Record<TerminalCallErrorCode, PortErrorCode> = {
  not_found: 'not_found',
  restricted: 'restricted',
  not_allowed: 'terminal_not_allowed',
  stopped: 'busy',
  unavailable: 'unavailable',
  failed: 'conflict',
}

/** Whether the user referenced a surface in a message to `sessionId`, or to New session's. */
function sharedWith(shared: Map<string, string | null>, id: string, sessionId: string): boolean {
  const to = shared.get(id)
  return to !== undefined && (to === null || to === sessionId)
}

export class AgentHost {
  readonly diagnostics: Diagnostics
  /** What each ACP session sent and received since the host started, for the Requests pane. */
  private readonly acpMessages = new AcpMessages()
  private readonly limitNotices = new LimitNotices()
  /** Each agent's session whose turn failed last, which a used-up window's notice may stand for. */
  private readonly lastFailed = new Map<AgentId, { sessionId: string; at: number }>()
  /** The session a used-up window stopped, by the window's key, which its reset opens. */
  private readonly stoppedBy = new Map<string, string>()
  readonly env: EnvironmentService
  readonly projects: Projects
  readonly scratch: ScratchFolders
  private readonly worktrees: WorktreeManager
  readonly agents: AgentManager
  /** What the agents last reported about their accounts and plans, kept across runs. */
  private readonly remembered: JsonFile<AgentsFile>
  /** What the last update check found, so a found update shows after a restart. */
  private readonly updates: JsonFile<AgentUpdatesFile>
  private readonly registryListing: JsonFile<RegistryListingFile>
  private readonly harnessManifest: JsonFile<HarnessManifestFile>
  private readonly star: GitHubStar
  /** Each agent's config options from its last new session, for New session. */
  private readonly agentOptions: AgentOptionsStore
  /** New session's prepared sessions not yet adopted or removed, for the host after a crash. */
  private readonly preparedRecords: PreparedRecords
  /** The agent processes and what they leave behind, until seen gone. */
  private readonly trees: AgentTrees
  readonly sessions: SessionManager
  /** When idle Claude Code sessions let their agent go, by the setting and the system's memory. */
  private readonly idleRelease: IdleRelease
  /** The computer's load, read only while a client watches it. */
  private readonly load: LoadMonitor
  private readonly system: SystemReader
  /** Whether the computer runs on battery, as main says on Windows; null until it has. */
  private onBattery: boolean | null = null
  /** The saved routines and the lifecycle of their runs. */
  readonly routines: RoutinesManager
  /** The user's workflow library. */
  readonly workflowLibrary: WorkflowLibrary
  /** The tasks that run through workflows. */
  readonly tasks: TaskEngine
  /** The cards the workflow tools leave in sessions, their answers and Start. */
  readonly workflowSuggestions: WorkflowSuggestions
  /** The attachments of drafts and queued prompts, until sent or removed. */
  readonly attachments: Attachments
  /** Every session's thread, read a page at a time, in a worker of its own. */
  readonly threads: ThreadStore | null
  /** Kettu's record and the agents' logs, in a worker of its own. */
  readonly usage: UsageManager
  /** Every project's artifacts, kept in the thread database and the data folder. */
  readonly artifacts: ArtifactStore
  /** The `kettu` MCP server, through which the sessions' agents reach the artifacts. */
  readonly artifactService: ArtifactService
  /** Kettu's memory of the user and of each project, which every session is handed. */
  readonly memory: MemoryService
  /** The artifacts' own data, which their pages and the agents read and write. */
  private readonly artifactData: ArtifactData
  /** Agents using the desktop apps of this computer; null on a host without the driver. */
  private readonly computer: ComputerUse | null
  /** What the user allowed the artifacts' pages, and the questions asking for it. */
  private readonly consents: ArtifactConsents
  /** The page runtime's requests in flight, from main and from devices' remote hosts. */
  private readonly runtimeRequests: RuntimeRequests
  /** The types artifacts are made from: their formats, guidance and exports. */
  readonly artifactTypes = new ArtifactTypes()
  readonly hub: PortHub
  private settings: HostSettings
  private readonly git: GitServiceApi | null
  /** Runs git for the project's files, with the agent environment. */
  private readonly execRunner: ExecRunner
  private readonly files: FilesService
  private readonly agentFiles: AgentFiles
  private readonly sessionFiles: SessionFiles
  /** Grants for the media a thread names and the Files pane opens, which main serves. */
  private readonly media: MediaService
  private gitUnsubscribe: (() => void)[] = []
  /** Ports keeping a project's git status live, by path key. */
  private readonly gitRetains = new GitRetains()
  /** Browser calls awaiting main's answer, by the id the call was given. */
  private readonly browserCalls = new Map<number, (answer: BrowserCallAnswer) => void>()
  private readonly deviceCalls = new Map<number, (answer: DeviceCallAnswer) => void>()
  private readonly terminalCalls = new Map<number, (answer: TerminalCallAnswer) => void>()
  private nextTerminalCall = 1
  // Sessions whose running turn used a terminal, told to the terminal host when the turn ends.
  private readonly terminalTurns = new Set<string>()
  // Terminals the user referenced in a message, by id, with the session it went to; null for New
  // session's, whose terminals go to the session it creates. Each allows that session's agent.
  private readonly sharedTerminals = new Map<string, string | null>()
  // Browser tabs and devices the user referenced the same way.
  private readonly sharedTabs = new Map<string, string | null>()
  private readonly sharedDevices = new Map<string, string | null>()
  /** Sessions whose running turn acted on a device, which the device host hears the end of. */
  private readonly deviceTurns = new Set<string>()
  private nextDeviceCall = 1
  private readonly deviceAccess: DeviceAccessStore
  /** Browser calls sent to the desktop apps that sent their turns. */
  private readonly deviceBrowser: DeviceBrowserCalls
  /** The running turns that use each session's page, whose end ends the page's agent state. */
  private readonly browserTurns = new BrowserTurns()
  /** The site each session's page last showed, from its calls' answers, which an asked step names. */
  private readonly browserSites = new Map<string, string>()
  /** The values of the Marketplace servers' inputs from main, held only in memory. */
  private marketKeys: MarketKeys = new Map()
  private agentEnvKeys: Record<string, Record<string, string>> = {}
  /** The secrets the plugins declare, by plugin then key, as main's key store holds them. */
  private pluginSecrets: Record<string, Record<string, string>> = {}
  /** Plugin secret changes awaiting main's answer: null once the store holds it, else why not. */
  private readonly pluginSecretCalls = new Map<number, (error: string | null) => void>()
  private nextPluginSecretCall = 1
  /** The Marketplace's catalog of MCP servers, from the registry. */
  private readonly marketCatalog: MarketCatalogService
  /** The sign-ins of the Marketplace's OAuth servers. */
  private readonly marketConnections: MarketConnectionsService
  /** Where agents reach the OAuth servers, with a fresh token. */
  private readonly mcpProxy: McpProxy
  /** The sign-ins sent to main that no push has carried back yet, by server id. */
  private readonly unkept = new Map<string, { state: string | null; pushes: number }>()
  /** The plugins Claude Code and Codex agents have of their own, which Kettu only lists. */
  private readonly ownPlugins: OwnPluginsService
  /** The skills catalog, the skills Kettu keeps, and what each agent gets of them. */
  private readonly marketSkills: MarketSkillsService
  /** The Kettu Marketplace's listings and the downloads of their files. */
  private readonly marketCommunity: MarketCommunityService
  private readonly marketBundles: MarketBundlesService
  private readonly plugins: PluginsService
  /** Kettu's own slash commands: the plugins' and the user's own. */
  private readonly commands: CommandsService
  /** Kettu's own roles: the plugins' and the user's own. */
  private readonly roles: RolesService
  /** The host's Kettu account from main, while signed in with Kettu's services on. */
  private marketAccount: MarketAccount | null = null
  /** Marketplace API calls awaiting main's answer. */
  private readonly marketCalls = new Map<number, (answer: MarketCallAnswer) => void>()
  private nextMarketCall = 1
  /** Trash calls awaiting main's answer: null once done, else why not. */
  private readonly trashCalls = new Map<number, (error: string | null) => void>()
  private nextTrashCall = 1
  /** Settings calls awaiting main's or the daemon's answer. */
  private readonly settingsCalls = new Map<number, (answer: SettingsCallAnswer) => void>()
  private nextSettingsCall = 1
  /** The settings tools of Kettu's MCP service. */
  private readonly settingsTools: SettingsTools
  /** What was put off or refused, to publish later. */
  private readonly publishDrafts: PublishDrafts
  /** The Marketplace tools of Kettu's MCP service. */
  private readonly marketTools: MarketTools
  private readonly pluginConverter: PluginConverter
  /** What each plugin's script keeps for itself, in its own folder. */
  private readonly pluginStorage = new PluginStorage(
    (pluginId) => this.plugins.folderOf(pluginId),
    (level, message) => writeLog(level, 'plugins', message),
  )
  /** The themes the plugins that are on bring, listed where main or the daemon reads them. */
  private readonly pluginThemes: PluginThemeIndex
  /** The plugin host, which runs the scripts of the installed plugins that are on. */
  private readonly pluginHost = new PluginHostClient({
    want: (run) => this.options.send({ type: 'host:plugin-host', run }),
    functions: createPluginApi({
      locale: () => this.settings.locale,
      colorMode: () => this.colorMode,
      sessions: {
        list: () => this.sessions.list(),
        turns: (sessionId) => this.sessions.historyTurns(sessionId),
        info: (sessionId) => this.sessions.sessionInfo(sessionId),
        summary: (sessionId) => this.sessions.summary(sessionId),
        startedBy: (starter) => this.sessions.startedBy(starter),
        agents: () => this.agents.statuses(),
        defaultAgent: () => this.settings.defaultAgent,
        project: (path) => {
          try {
            return this.projects.match(path).path
          } catch {
            throw new Error(`${path.slice(0, 200)} is not a project of the user's`)
          }
        },
        start: (pluginId, params) => this.sessions.startFromPlugin(pluginId, params),
        send: (pluginId, sessionId, text) =>
          this.sessions.sendFromPlugin(pluginId, sessionId, text),
        now: () => Date.now(),
      },
      own: {
        setting: (pluginId, key) => this.plugins.settingValue(pluginId, key),
        secret: (pluginId, key) => this.pluginSecret(pluginId, key),
        storage: this.pluginStorage,
      },
      channels: {
        answer: (pluginId, request, decision, from) =>
          this.pluginChannels.answer(pluginId, request, decision, from),
      },
    }),
    onStatus: () => this.hub.broadcast({ type: 'plugins.changed' }),
    log: (level, message) => writeLog(level, 'plugins', message),
  })
  /** The tools of the plugins that are on, which Kettu's MCP service lists. */
  private readonly pluginTools = new PluginTools({
    installed: () => this.plugins.tools(),
    client: this.pluginHost,
    log: (level, message) => writeLog(level, 'plugins', message),
  })
  /** What a plugin's mention sources and links ask of its script, and what it answers. */
  private readonly pluginRefs = new PluginRefs({
    client: this.pluginHost,
    source: (pluginId) => this.plugins.refSources().find((s) => s.pluginId === pluginId) ?? null,
    locale: () => this.settings.locale,
    log: (level, message) => writeLog(level, 'plugins', message),
  })
  /** The window's color mode, from main; null under the daemon, which has no window. */
  private colorMode: ColorMode | null = null
  private readonly pluginScripts = new InstalledScripts(this.pluginHost, (pluginId, error) =>
    writeLog('warn', 'plugins', `Could not unload ${pluginId}: ${(error as Error).message}`),
  )
  /** Kettu's own events as the plugins that name them hear of them. */
  private readonly pluginHooks = new PluginHooks({
    client: this.pluginHost,
    refs: this.pluginRefs,
    title: (pluginId) => this.plugins.titleOf(pluginId),
    log: (level, message) => writeLog(level, 'plugins', message),
  })
  /** Kettu's notices as the channels of plugins hear of them, and the answers relayed from there. */
  private readonly pluginChannels = new PluginChannels({
    routes: () => this.plugins.channelRoutes(),
    deliver: (pluginId, channel, notice) =>
      this.pluginHooks.tell(pluginId, channelTrigger(channel), PLUGIN_CHANNEL_EVENT, notice),
    relay: (sessionId, requestId, optionId, relay) =>
      this.sessions.relayPermission(sessionId, requestId, optionId, relay),
    title: (pluginId) => this.plugins.titleOf(pluginId),
    plain: (kind) =>
      ({
        permission: t('plugins.channelTitle.permission'),
        turnEnded: t('plugins.channelTitle.turnEnded'),
        error: t('plugins.channelTitle.error'),
        routines: t('plugins.channelTitle.routines'),
        planLimits: t('plugins.channelTitle.planLimits'),
      })[kind],
  })
  /** What a plugin's views are asked of its script, and what it answers. */
  private readonly pluginViews = new PluginViews({
    client: this.pluginHost,
    views: (pluginId) => this.plugins.views(pluginId),
    actions: (pluginId) => this.plugins.actions(pluginId),
    locale: () => this.settings.locale,
    log: (level, message) => writeLog(level, 'plugins', message),
  })
  private lastProcesses = '[]'
  private sentFolders: string | null = null
  private stopping: Promise<void> | null = null
  private readonly catalog: readonly AgentDefinition[]

  private constructor(private readonly options: HostOptions) {
    const { platform } = options
    this.settings = options.settings
    setLocale(options.settings.locale)
    this.diagnostics = new Diagnostics({ mirrorTraffic: options.mirrorTraffic ?? false })
    const log = this.diagnostics.log.bind(this.diagnostics)
    this.env = new EnvironmentService({
      platform,
      nodeRuntime: options.nodeRuntime,
      baseEnv: options.baseEnv,
      ...(options.resolveEnv ? { resolve: options.resolveEnv } : {}),
      ...(options.probeNode ? { probe: options.probeNode } : {}),
    })
    const catalog = buildCatalog(options.fakeAgentPath)
    this.catalog = catalog
    this.env.setProxy(options.settings.proxy)
    this.env.setConfigFolders(configFolders(catalog, options.settings))
    this.execRunner = createExec(() => this.env.agentEnv() as NodeJS.ProcessEnv)
    this.media = new MediaService({
      platform,
      homeDir: options.homeDir ?? os.homedir(),
      names: (sessionId, text) => this.sessions.names(sessionId, text),
      grant: (grant) => options.send({ type: 'host:media-grant', grant }),
    })
    this.files = new FilesService({
      exec: this.execRunner.exec,
      platform,
      media: (real, info) => this.media.grantFile(real, info, null, true),
      describeMedia: (real, info) => this.media.describe(real, info, true),
      trash: (paths) => this.trash(paths),
    })
    this.agentFiles = new AgentFiles({
      platform,
      homeDir: options.homeDir ?? os.homedir(),
      session: (sessionId) => this.sessions.agentSession(sessionId),
      read: (real, shown) => this.files.readAllowed(real, shown),
    })
    this.sessionFiles = new SessionFiles({
      platform,
      folder: (sessionId) => this.sessions.workFolder(sessionId),
      read: (folder, relative) =>
        this.filesCall(folder, (root) => this.files.read(root, relative, true)),
    })
    this.deviceAccess = new DeviceAccessStore(options.userDataPath, log)
    this.publishDrafts = new PublishDrafts(options.userDataPath, log)
    this.pluginConverter = new PluginConverter({
      call: (call) => this.marketCall(call),
      appVersion: options.appVersion,
      folder: path.join(options.userDataPath, 'plugin-conversions'),
    })
    this.marketTools = new MarketTools({
      account: () => this.marketAccount,
      call: (call) => this.marketCall(call),
      ask: (sessionId, ask) => this.sessions.marketAsked(sessionId, ask, MARKET_WAIT_MS),
      settle: (sessionId, entryId, outcome) =>
        this.sessions.marketSettled(sessionId, entryId, outcome),
      tell: (sessionId, text) => {
        this.sessions.sendCardAnswer(sessionId, text).catch((error: unknown) => {
          log('warn', `Could not tell a session about its card: ${(error as Error).message}`)
        })
      },
      drafts: this.publishDrafts,
      changed: () => this.hub.broadcast({ type: 'market.publishedChanged' }),
      agentOf: (sessionId) => this.sessions.sessionAgent(sessionId),
      sessionTitle: (sessionId) => this.sessions.title(sessionId),
      taskWorkflow: async (taskId) => {
        const draft = this.tasks.writtenDraft(taskId)
        if (!draft) return null
        const text = await this.workflowSuggestions.draftText(draft)
        return { title: this.tasks.get(taskId).title, text }
      },
      taskWorkflowFolder: (taskId) => {
        try {
          return this.tasks.writtenDraft(taskId) ? this.taskPublishFolder(taskId) : null
        } catch (error) {
          if (error instanceof HostError && error.code === 'not_found') return null
          throw error
        }
      },
      converter: this.pluginConverter,
      appVersion: options.appVersion,
      home: options.homeDir ?? os.homedir(),
    })
    this.settingsTools = new SettingsTools({
      platform,
      read: () => this.settingsCall({ kind: 'read' }),
      apply: (patch) => this.settingsCall({ kind: 'change', patch }),
      setPluginSetting: async (pluginId, key, value) => {
        await this.plugins.setSetting(pluginId, key, value)
      },
      local: () => this.settingsLocal(),
      fullAccess: (sessionId) => this.sessions.settingsFullAccess(sessionId),
      ask: (sessionId, ask) => this.sessions.settingsAsked(sessionId, ask, SETTINGS_WAIT_MS),
      recorded: (sessionId, items) => this.sessions.settingsRecorded(sessionId, items),
      settle: (sessionId, entryId, outcome) =>
        this.sessions.settingsSettled(sessionId, entryId, outcome),
      open: (sessionId, target) => this.openSettings(sessionId, target),
      words: tSettings,
      english: tSettingsEnglish,
    })
    this.projects = new Projects({ file: projectsFile(options.userDataPath, log), platform })
    this.scratch = new ScratchFolders(path.join(options.userDataPath, 'scratch'), platform)
    this.remembered = agentsFile(options.userDataPath, log)
    this.updates = agentUpdatesFile(options.userDataPath, log)
    this.registryListing = registryListingFile(options.userDataPath, log)
    this.harnessManifest = harnessManifestFile(options.userDataPath, log)
    this.star = new GitHubStar({
      file: gitHubStarFile(options.userDataPath, log),
      git: () => this.git,
      changed: (state) => this.broadcast({ type: 'star.changed', state }),
      log,
    })
    this.agentOptions = new AgentOptionsStore({
      file: agentOptionsFile(options.userDataPath, log),
      changed: (changed) =>
        this.hub.broadcast({ type: 'agent.options', options: this.withStartMode(changed) }),
    })
    this.preparedRecords = new PreparedRecords(preparedFile(options.userDataPath, log))
    this.marketCatalog = new MarketCatalogService({
      file: catalogFile(options.userDataPath, log),
      log,
    })
    this.marketConnections = new MarketConnectionsService({
      log,
      servers: () => this.settings.marketplace.mcp,
      headers: (server) => serverHeaders(server, this.marketKeys),
      keep: (serverId, state) => this.keepSignIn(serverId, state),
      changed: (serverId, connection, loginId, error) =>
        this.connectionChanged(serverId, connection, loginId, error),
    })
    this.mcpProxy = new McpProxy({
      servers: () => this.settings.marketplace.mcp,
      headers: (server) => serverHeaders(server, this.marketKeys),
      token: (serverId) => this.marketConnections.token(serverId),
      refused: (serverId, used) => this.marketConnections.refused(serverId, used),
    })
    const home = options.homeDir ?? os.homedir()
    this.ownPlugins = new OwnPluginsService({
      platform,
      agents: () => this.installedAgents(['claude-code', 'codex']),
      program: (agentId) => this.agents.harnessProgram(agentId),
      appServer: (agentId) => this.appServer(agentId),
    })
    this.marketCommunity = new MarketCommunityService({
      userDataPath: options.userDataPath,
      log,
      account: () => this.marketAccount,
      call: (call) => this.marketCall(call),
      kept: () => [
        ...[...this.settings.marketplace.skills, ...this.settings.marketplace.mcp].flatMap(
          (item) => listingIdOf(item.id) ?? [],
        ),
        ...this.workflowLibrary.listingIds(),
      ],
      installWorkflow: (text, origin) => this.workflowLibrary.installListing(text, origin),
    })
    this.marketBundles = new MarketBundlesService({
      userDataPath: options.userDataPath,
      file: bundlesFile(options.userDataPath, log),
      log,
      platform,
      home,
      nodeVersion: process.versions.node,
      listing: (id) => this.marketCommunity.listing(id),
      download: (id, kind) => this.marketCommunity.download(id, kind),
      find: (command) =>
        findCommand(command, {
          platform,
          env: this.env.agentEnv() as Env,
          isExecutable: (file) => isExecutableFile(file, platform),
        }),
      servers: () => this.settings.marketplace.mcp,
    })
    void this.marketBundles.sweep()
    this.marketSkills = new MarketSkillsService({
      userDataPath: options.userDataPath,
      file: skillsCatalogFile(options.userDataPath, log),
      log,
      platform,
      home,
      settings: () => this.settings.marketplace.skills,
      agents: () => this.agents.ids().filter((id) => !this.settings.disabledAgents.includes(id)),
      configFolder: (agentId) => this.agents.configFolder(agentId),
      codexSkills: async (agentId) => {
        if ((await this.installedAgents(['codex'], [agentId])).length === 0) return null
        return (await this.appServer(agentId))<SkillsListResponse>('skills/list', { cwds: [home] })
      },
      kettu: (id) => this.marketCommunity.download(id, 'skill'),
      ownSkills: () => this.artifactService.guideFlags,
      kettuOn: (agentId) => !this.settings.mcp.kettu.off.includes(agentId),
    })
    this.trees = new AgentTrees({
      file: agentProcessesFile(options.userDataPath, log),
      control: options.processControl ?? processControl(platform),
      graceMs: STOP_TIMINGS.termMs,
      ...(options.treeNoteMs !== undefined ? { noteMs: options.treeNoteMs } : {}),
      log,
    })
    this.attachments = new Attachments({ userDataPath: options.userDataPath, log })
    const contentDir = path.join(options.userDataPath, 'artifacts', 'content')
    this.threads = options.threadWorker
      ? new ThreadStore({
          file: path.join(options.userDataPath, 'state', 'threads.db'),
          contentDir,
          createWorker: options.threadWorker,
          log,
        })
      : null
    this.artifacts = new ArtifactStore({
      threads: this.threads,
      contentDir,
      log,
      changed: () => {
        this.hub.broadcast({ type: 'artifacts.changed' })
        this.options.send({ type: 'host:artifacts-changed' })
      },
      version: (portIds, id, version) =>
        this.hub.send(portIds, { type: 'artifacts.version', id, version }),
      // Each port hears of the other clients showing the artifact, named as it knows them.
      activity: (portIds, activity) => {
        const showing = [...portIds]
        for (const portId of showing) {
          this.hub.send([portId], {
            type: 'artifacts.activity',
            ...activity,
            clients: this.hub.viewers(showing, portId).map((viewer) => ({
              ...viewer,
              page:
                activity.pages.get(
                  showing.find((p) =>
                    viewer.kind === 'host'
                      ? !this.hub.deviceOf(p)
                      : this.hub.deviceOf(p)?.id === viewer.id,
                  ) ?? '',
                ) ?? null,
            })),
          })
        }
      },
      comments: (portIds, id) => this.hub.send(portIds, { type: 'artifacts.comments', id }),
      seen: (id, version) => this.hub.broadcast({ type: 'artifacts.seen', id, version }),
      canvas: (portIds, event) => this.hub.send(portIds, { type: 'artifacts.canvas', ...event }),
      unwatched: (id) => this.consents.unwatched(id),
    })
    this.artifactData = new ArtifactData({ store: this.artifacts })
    registerContentCapability({ store: this.artifacts, types: this.artifactTypes })
    const computer = options.computer ?? null
    this.computer = computer
      ? new ComputerUse({
          platform,
          driver: new ComputerDriver({ path: computer.driverPath, log }),
          self: { pids: [computer.selfPid, process.pid], ids: computer.selfIds },
          settings: () => this.settings.computerUse,
          turnRefusal: (sessionId) => this.sessions.computerRefusal(sessionId),
          sessionTitle: (sessionId) => this.sessions.title(sessionId) ?? 'Untitled',
          asked: (sessionId, requestId, app) =>
            this.sessions.computerAppAsked(sessionId, requestId, app),
          settled: (requestId, answer) => this.sessions.computerAppSettled(requestId, answer),
          allowAlways: (app) => options.send({ type: 'host:computer-app-allow', app }),
          using: (sessionId, view) => this.sessions.computerUsing(sessionId, view),
          permissions: () => probePermissions({ path: computer.driverPath, log }),
          setupAsked: (sessionId, requestId, steps) =>
            this.sessions.computerSetupAsked(sessionId, requestId, steps),
          setupDone: (requestId, done) => this.sessions.computerSetupDone(requestId, done),
          setupSettled: (requestId, outcome) =>
            this.sessions.computerSetupSettled(requestId, outcome),
          stopped: (sessionId) => this.sessions.computerStopped(sessionId),
          handedBack: (sessionId, durationMs) =>
            this.sessions.controlHandedBack(sessionId, 'computer', durationMs),
          paused: (sessionId, app) => this.sessions.controlPaused(sessionId, 'computer', app),
          agent: (sessionId) => ({
            id: this.sessions.sessionAgent(sessionId) ?? '',
            name: this.sessions.agentName(sessionId),
          }),
          held: (hold) => options.send({ type: 'host:computer-hold', hold }),
          log,
        })
      : null
    this.memory = new MemoryService({
      root: path.join(options.userDataPath, 'memory'),
      log,
      projects: () => this.projects.list().map(({ path, name }) => ({ path, name })),
      claudeAgents: () => this.claudeAgents(),
    })
    this.memory.onChange(() => this.hub.broadcast({ type: 'memory.changed' }))
    this.workflowLibrary = new WorkflowLibrary({
      dir: path.join(options.userDataPath, 'workflows'),
      file: workflowsFile(options.userDataPath, log),
      knownTools: () => ({
        mcp: new Set(this.settings.marketplace.mcp.flatMap((server) => [server.name, server.id])),
        skills: new Set(
          this.settings.marketplace.skills.flatMap((skill) => [skill.name, skill.id]),
        ),
      }),
      log,
      changed: () => this.broadcast({ type: 'workflows.changed' }),
      pluginOn: (pluginId) => this.plugins.on(pluginId),
    })
    this.pluginThemes = new PluginThemeIndex({
      file: path.join(options.userDataPath, PLUGIN_THEMES_FILE),
      resources: () => this.plugins.resources('themes'),
      changed: () => options.send({ type: 'host:plugin-themes' }),
      log: (level, message) => writeLog(level, 'plugins', message),
    })
    this.plugins = new PluginsService({
      userDataPath: options.userDataPath,
      file: kettuPluginsFile(options.userDataPath, log),
      log,
      appVersion: options.appVersion,
      settings: async () => {
        const { marketplace } = (await this.settingsCall({ kind: 'read' })).file
        return { skills: marketplace.skills, servers: marketplace.mcp }
      },
      editSettings: async ({ skills, servers }) => {
        await this.settingsCall({
          kind: 'change',
          plugins: true,
          patch: {
            marketplace: {
              ...(skills ? { skillsEdit: skills } : {}),
              ...(servers ? { mcpEdit: servers } : {}),
            },
          },
        })
      },
      keepSkill: (id, name, files) => this.marketSkills.keepFiles(id, name, files),
      workflows: {
        install: (text, origin) => this.workflowLibrary.installPlugin(text, origin),
        remove: (pluginId, keep) => this.workflowLibrary.removePlugin(pluginId, keep),
        changed: () => this.workflowLibrary.pluginChanged(),
      },
      kettu: (id) => this.marketCommunity.download(id, 'agent-plugin'),
      listing: (id) => this.marketCommunity.listing(id),
      count: (id, version, reason) => void this.marketCommunity.count(id, version, reason),
      scriptState: (pluginId) =>
        this.pluginHost.status().find((plugin) => plugin.id === pluginId)?.state ?? 'idle',
      secretsSet: (pluginId) => Object.keys(this.pluginSecrets[pluginId] ?? {}),
      removed: (pluginId) => this.pluginRemoved(pluginId),
      settingChanged: (pluginId, key) => this.pluginSettingEvent(pluginId, key, false),
      changed: () => {
        this.pluginScripts.sync(this.plugins.scripts())
        this.hub.broadcast({ type: 'plugins.changed' })
        void this.pluginThemes.sync()
      },
    })
    this.roles = new RolesService({
      userDataPath: options.userDataPath,
      plugins: () => this.plugins.resources('roles'),
      kept: () => ({
        skills: this.settings.marketplace.skills,
        mcp: this.settings.marketplace.mcp,
      }),
      log,
    })
    this.commands = new CommandsService({
      userDataPath: options.userDataPath,
      plugins: () => this.plugins.resources('commands'),
      kept: () => ({
        skills: this.settings.marketplace.skills,
        mcp: this.settings.marketplace.mcp,
      }),
      log,
    })
    this.artifactService = new ArtifactService({
      workflow: {
        library: this.workflowLibrary,
        marketplace: this.marketCommunity,
        report: (sessionId, input) => this.tasks.report(sessionId, input),
        pick: (sessionId, picks) => this.tasks.pick(sessionId, picks),
        suggestions: {
          suggest: (sessionId, input) => this.workflowSuggestions.suggest(sessionId, input),
          draft: (sessionId, text) => this.workflowSuggestions.draft(sessionId, text),
          keep: (sessionId, text) => this.workflowSuggestions.keep(sessionId, text),
        },
        isStep: (sessionId) => this.tasks.refOf(sessionId) !== null,
        agentOf: (sessionId) => this.sessions.sessionAgent(sessionId),
      },
      data: this.artifactData,
      store: this.artifacts,
      types: this.artifactTypes,
      templates: new PluginTemplates({ resources: () => this.plugins.resources('templates'), log }),
      sessionTitle: (sessionId) => this.sessions.title(sessionId),
      runningTurn: (sessionId) => this.sessions.runningTurn(sessionId),
      sessionOf: (process, id) => this.sessions.sessionOf(process, id),
      subagentCall: (process, id) => this.sessions.isSubagentCall(process, id),
      plan: { set: (sessionId, items) => this.sessions.planSet(sessionId, items) },
      report: { add: (sessionId, draft) => this.sessions.reportDrafted(sessionId, draft) },
      memory: {
        service: this.memory,
        projectOf: (caller) => this.projects.find(caller.project)?.path ?? null,
        written: (sessionId, write) => this.sessions.memoryWritten(sessionId, write),
        proposed: (sessionId, proposal) => this.sessions.memoryProposed(sessionId, proposal),
        agentOf: (sessionId) => this.sessions.sessionAgent(sessionId),
      },
      wrote: (sessionId, write) => this.sessions.artifactWritten(sessionId, write),
      browserCall: (request, caller) => this.browserCall(request, caller),
      browserAccess: {
        fullAccess: (sessionId) => this.sessions.surfaceAccessOf(sessionId).fullAccess,
        ask: (sessionId, tab) =>
          this.sessions.surfaceAccessAsked(
            sessionId,
            { surface: 'browser', id: tab.id, name: tab.title },
            { readOnly: false },
            SURFACE_ACCESS_WAIT_MS,
          ),
        used: (sessionId, title) => this.sessions.surfaceUsed(sessionId, 'browser', title),
        shared: (sessionId, tabId) => sharedWith(this.sharedTabs, tabId, sessionId),
      },
      browserSession: (sessionId) => this.sessions.browserSession(sessionId),
      devices: {
        call: (call) => this.deviceCall(call),
        agentName: (sessionId) => this.sessions.agentName(sessionId),
        ask: (sessionId, deviceId, deviceName) =>
          this.sessions.deviceAccessAsked(sessionId, deviceId, deviceName, DEVICE_ACCESS_WAIT_MS),
        alwaysAllowed: (deviceId) => this.deviceAccess.has(deviceId),
        fullAccess: (sessionId) => this.sessions.surfaceAccessOf(sessionId).fullAccess,
        used: (sessionId, name) => this.sessions.surfaceUsed(sessionId, 'device', name),
        shared: (sessionId, deviceId) => sharedWith(this.sharedDevices, deviceId, sessionId),
        allowAlways: (deviceId) => this.deviceAccess.add(deviceId),
      },
      terminals: {
        call: (call) => this.terminalCall(call),
        agentOf: (sessionId) => this.sessions.sessionAgent(sessionId),
        accessOf: (sessionId) => this.sessions.surfaceAccessOf(sessionId),
        ask: (sessionId, terminal, ask) =>
          this.sessions.surfaceAccessAsked(
            sessionId,
            { surface: 'terminal', id: terminal.id, name: terminal.name ?? terminal.title },
            ask,
            SURFACE_ACCESS_WAIT_MS,
          ),
        used: (sessionId, terminal) =>
          this.sessions.surfaceUsed(sessionId, 'terminal', terminal.name ?? terminal.title),
        shared: (sessionId, terminalId) => sharedWith(this.sharedTerminals, terminalId, sessionId),
        passwords: () => this.settings.agentPasswords,
      },
      sessionProject: (sessionId) => this.sessions.sessionProject(sessionId),
      sessionFolder: (sessionId) => this.sessions.sessionFolder(sessionId),
      ...(this.computer ? { computer: this.computer } : {}),
      market: this.marketTools,
      settings: this.settingsTools,
      plugins: this.pluginTools,
      skills: {
        of: (sessionId) => {
          const agentId = this.sessions.sessionAgent(sessionId)
          if (!agentId) return null
          const task = this.sessions.sessionTask(sessionId)
          const step = task ? (this.tasks.toolsOf(task)?.skills ?? []) : []
          const added = this.sessions.sessionCommandTools(sessionId)?.skills ?? []
          return this.marketSkills.sessionSkills(agentId, [...step, ...added])
        },
      },
      proxy: this.mcpProxy,
      sessions: {
        info: (sessionId) => this.sessions.sessionInfo(sessionId),
        list: (projectPath) => this.sessions.toolSessions(projectPath),
        lastReply: (sessionId) => this.sessions.lastReply(sessionId),
        rename: (sessionId, title) => this.sessions.renameByAgent(sessionId, title),
        work: (sessionId) => this.sessions.runningWork([sessionId]),
        archiveAfterTurn: (sessionId, agentName) =>
          this.sessions.archiveWhenIdle(sessionId, agentName),
        archiveNow: (sessionId, agentName) => this.sessions.archiveStarted(sessionId, agentName),
        start: (callerId, params) => this.sessions.startFromTool(callerId, params),
        carried: (callerId, agentId) => this.sessions.carriedOptions(callerId, agentId),
        agentOptions: (agentId) => this.agentOptions.get(agentId),
        readOptions: (agentId) => this.agents.readFirstOptions(agentId),
        choices: (sessionId) => this.sessions.toolChoices(sessionId),
        held: (sessionId) => this.sessions.firstHeld(sessionId),
        send: (sessionId, text, from, now) =>
          this.sessions.sendFromTool(sessionId, text, from, now),
        started: (callerId) => this.sessions.startedBy(callerId),
        name: (sessionId) => this.sessions.toolName(sessionId),
        agentName: (sessionId) => this.sessions.agentName(sessionId),
        agentLabel: (agentId) => this.agents.name(agentId),
        agents: () => this.agents.statuses(),
        roles: () => this.roles.list(),
        role: (ref) => this.roles.get(ref),
        history: (sessionId) => this.sessions.historyTurns(sessionId),
        mode: (sessionId) => this.sessions.toolMode(sessionId),
        starterRank: (sessionId) => this.sessions.starterRank(sessionId),
        startMode: (agentId) => startModeIn(this.settings, agentId),
      },
      log,
      appVersion: options.appVersion,
    })
    const usageStore = options.usageWorker
      ? new UsageStore({
          file: path.join(options.userDataPath, 'state', 'usage.db'),
          createWorker: options.usageWorker,
          log,
          onChanged: () => this.usage.rowsChanged(),
          onProgress: (progress) => this.usage.progressed(progress),
          onStatus: (status) => this.usage.storeStatus(status),
        })
      : null
    this.usage = new UsageManager({
      store: usageStore,
      readers: options.usageReaders ?? LOG_READERS,
      fromComputer: options.settings.usage.fromComputer,
      platform,
      home: options.homeDir ?? os.homedir(),
      env: async (agentId) => {
        await this.env.ready()
        return this.env.agentEnv(agentId)
      },
      isScratch: (folder) => this.scratch.contains(folder),
      worktreeProject: (folder) => this.sessions.worktreeProject(folder),
      log,
      changed: () => this.hub.broadcast({ type: 'usage.changed' }),
      status: (status) => this.hub.broadcast({ type: 'usage.status', status }),
      ...(options.usageTimings ? { timings: options.usageTimings } : {}),
    })
    const adaptersDir = harnessesFolder(options)
    this.agents = new AgentManager({
      catalog,
      platform,
      nodeRuntime: options.nodeRuntime,
      appVersion: options.appVersion,
      env: this.env,
      diagnostics: this.diagnostics,
      acpMessages: this.acpMessages,
      launcher: options.launcher ?? processLauncher(platform),
      settings: () => this.settings,
      reportsDir: path.join(options.userDataPath, 'agent-reports'),
      adaptersDir,
      sessionRouterPath: options.sessionRouterPath ?? null,
      clineHostPath: options.clineHostPath ?? null,
      ...(options.detect ? { detect: options.detect } : {}),
      ...(options.protocols ? { protocols: options.protocols } : {}),
      ...(options.drivers ? { drivers: options.drivers } : {}),
      ...(options.agentTimings ? { timings: options.agentTimings } : {}),
      status: (status) => {
        this.hub.broadcast({ type: 'agent.status', status })
        this.limitsNoticed(status)
        this.routines.limitsChanged(status.id)
        this.tasks?.recheck()
      },
      removed: (agentId) => this.hub.broadcast({ type: 'agent.removed', agentId }),
      processes: (processes) => this.reportProcesses(processes),
      trees: this.trees,
      authCommands: (commands) => options.send({ type: 'host:auth-commands', commands }),
      remember: (file) => this.remembered.save(file),
      rememberUpdates: (file) => this.updates.save(file),
      rememberRegistry: (file) => this.registryListing.save(file),
      rememberManifest: (file) => this.harnessManifest.save(file),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      launchEnv: (agentId, env) => ({
        ...this.marketSkills.launchEnv(agentId, env),
        ...(this.agentEnvKeys[agentId] ?? {}),
      }),
      envKeyIsSet: (agentId, variable) =>
        typeof this.agentEnvKeys[agentId]?.[variable] === 'string',
    })
    const routineHooks: RoutineSessionHooksRef = { current: null }
    const taskHooks: TaskSessionHooksRef = { current: null }
    this.worktrees = new WorktreeManager({
      git: createWorktreeGit({
        exec: this.execRunner.exec,
        platform,
        homeDir: options.homeDir ?? os.homedir(),
      }),
      platform,
      settings: (projectPath) => this.projects.worktreeSettings(projectPath),
      root: () => this.settings.git.worktreeRoot,
      env: async () => {
        await this.env.ready()
        return this.env.agentEnv() as NodeJS.ProcessEnv
      },
      takenByPullRequest: (projectPath, branch) =>
        this.git?.branchPullRequests(projectPath).has(branch) ?? false,
      log,
    })
    this.idleRelease = new IdleRelease({
      platform,
      settings: () => this.settings.idleSessions,
      log: (level, message) => this.diagnostics.log(level, message),
      changed: () => {
        this.sessions.idleRulesChanged()
        this.hub.broadcast({ type: 'idleRelease.changed', state: this.idleRelease.state() })
      },
    })
    this.system = new SystemReader({
      platform,
      // The volumes that hold a project, the worktrees or Kettu's data.
      folders: () => [
        options.userDataPath,
        ...this.projects.paths(),
        ...(this.settings.git.worktreeRoot ? [this.settings.git.worktreeRoot] : []),
      ],
      onBattery: () => this.onBattery,
      log: (level, message) => this.diagnostics.log(level, message),
    })
    this.load = new LoadMonitor({
      source: {
        sample: () => this.system.sample(),
        read: (from, to) => this.system.read(from, to),
        forget: () => this.system.forget(),
      },
      send: (portIds, event) => this.hub.send(portIds, event),
      log: (level, message) => this.diagnostics.log(level, message),
    })
    this.sessions = new SessionManager({
      platform,
      agents: this.agents,
      projects: this.projects,
      scratch: this.scratch,
      worktrees: this.worktrees,
      file: sessionsFile(options.userDataPath, log),
      returned: returnedFile(options.userDataPath, log),
      projectMcp: new ProjectMcpAnswers(projectMcpFile(options.userDataPath, log)),
      projectHooks: new ProjectHooksAnswers(projectHooksFile(options.userDataPath, log)),
      portOpen: (portId) => this.hub.has(portId),
      portDevice: (portId) => this.hub.deviceOf(portId),
      threads: this.threads,
      agentFile: (sessionId, file) =>
        this.agentFiles.read(sessionId, file).then(
          (content) => (content.kind === 'text' ? content.text : null),
          (error: unknown) => {
            log('warn', `Could not read ${file}: ${(error as Error).message}`)
            return null
          },
        ),
      projectFile: (sessionId, file) =>
        this.sessionFiles.text(sessionId, file).catch((error: unknown) => {
          log('warn', `Could not read ${file}: ${(error as Error).message}`)
          return null
        }),
      reportsDir: path.join(options.userDataPath, 'agent-reports'),
      attachments: this.attachments,
      mcp: {
        servers: (sessionId, record, connection) => {
          const gateway = this.agents.toolGateway(record.agentId)
          return this.agents.mcpServersByName(record.agentId)
            ? this.artifactService.folderServers(connection, record.projectPath, sessionId, gateway)
            : this.artifactService.servers(sessionId, record.projectPath, gateway)
        },
        library: (sessionId, record, connection, transports, taken) =>
          libraryServers(
            this.settings.marketplace.mcp,
            this.marketKeys,
            record.agentId,
            transports,
            {
              platform,
              taken,
              node: options.nodeRuntime,
              also: [
                ...(record.task ? (this.tasks.toolsOf(record.task)?.mcp ?? []) : []),
                ...(record.commandTools?.mcp ?? []),
              ],
              oauth: {
                access: (server) => this.marketConnections.access(server),
                bearer: () =>
                  this.artifactService.bearer(
                    sessionId,
                    record.projectPath,
                    this.agents.mcpServersByName(record.agentId) ? connection : null,
                  ),
              },
            },
          ),
        detached: (sessionId) => {
          this.artifactService.revoke(sessionId)
          this.artifacts.stopUsing(sessionId)
          this.computer?.forget(sessionId)
          this.browserSites.delete(sessionId)
        },
        guide: (agentId) =>
          this.artifactService.guidePrompt(
            this.marketSkills.loadsSkills(agentId),
            this.agents.toolGateway(agentId),
          ),
        turnEnded: (sessionId) => {
          this.artifacts.stopUsing(sessionId)
          this.computer?.turnEnded(sessionId)
          this.browserTurnEnded(sessionId)
          this.marketTools.turnEnded(sessionId)
          this.settingsTools.turnEnded(sessionId)
          if (this.deviceTurns.delete(sessionId)) {
            this.options.send({ type: 'host:device-turn-ended', sessionId })
          }
          if (this.terminalTurns.delete(sessionId)) {
            this.options.send({ type: 'host:terminal-turn-ended', sessionId })
          }
        },
      },
      skills: (record, kettu) =>
        this.marketSkills.sessionOptions(record.agentId, kettu, [
          ...(record.task ? (this.tasks.toolsOf(record.task)?.skills ?? []) : []),
          ...(record.commandTools?.skills ?? []),
        ]),
      roles: { resolve: (ref) => this.roles.resolve(ref) },
      plugins: this.pluginHooks,
      commands: {
        expand: (text, own) => this.commands.expand(text, own),
        extra: (agentId, needs) => {
          const { skills, mcp } = this.settings.marketplace
          const kept = <T extends { id: string; name: string }>(list: readonly T[], name: string) =>
            list.find((item) => item.name === name || item.id === name)
          return {
            skills: needs.skills.filter((name) => {
              const skill = kept(skills, name)
              return !!skill && !skillFor(skill, agentId)
            }),
            mcp: needs.mcp.filter((name) => {
              const server = kept(mcp, name)
              return !!server && !serverFor(server, agentId)
            }),
          }
        },
      },
      memory: this.memory,
      usage: this.usage,
      cacheTtl:
        options.cacheTtl ??
        claudeCacheTtl({
          platform,
          home: options.homeDir ?? os.homedir(),
          env: async () => {
            await this.env.ready()
            return this.env.agentEnv('claude-code')
          },
          log,
        }),
      modelRequests: byHarness(
        {
          'claude-code': claudeModelRequests({
            platform,
            home: options.homeDir ?? os.homedir(),
            env: async () => {
              await this.env.ready()
              return this.env.agentEnv('claude-code')
            },
          }),
          codex: codexModelRequests({
            home: options.homeDir ?? os.homedir(),
            env: async () => {
              await this.env.ready()
              return this.env.agentEnv('codex')
            },
          }),
          opencode: opencodeModelRequests({ sessions: (agentId) => this.agents.openCode(agentId) }),
          cline: clineModelRequests({
            home: options.homeDir ?? os.homedir(),
            env: async () => {
              await this.env.ready()
              return this.env.agentEnv('cline')
            },
          }),
        },
        acpModelRequests(this.acpMessages),
      ),
      outside:
        options.outside ??
        claudeOutside({
          platform,
          home: options.homeDir ?? os.homedir(),
          env: async () => {
            await this.env.ready()
            return this.env.agentEnv('claude-code')
          },
          log,
        }),
      idleRelease: this.idleRelease,
      diagnostics: this.diagnostics,
      git: () => this.git,
      options: this.agentOptions,
      settings: () => this.settings,
      ...(options.sessionTimings ? { timings: options.sessionTimings } : {}),
      prepared: this.preparedRecords,
      settingsTargets: (agentId, folder) =>
        settingsTargets(
          agentId,
          folder,
          (name) => this.env.get(name, agentId),
          options.homeDir ?? os.homedir(),
          platform,
        ),
      routine: routineHooks,
      task: taskHooks,
      cards: {
        waiting: (sessionId) => this.workflowSuggestions.waitingCount(sessionId),
        turnStarted: (sessionId) => void this.workflowSuggestions.turnStarted(sessionId),
      },
      events: {
        patches: (batch, portIds) => this.hub.send(portIds, { type: 'session.patches', batch }),
        summary: (summary, portIds) => {
          if (portIds) {
            this.hub.send(portIds, { type: 'session.summary', summary })
            return
          }
          this.hub.broadcast({ type: 'session.summary', summary })
          if (summary.scratch || summary.worktree) this.sendFolders()
        },
        removed: (sessionId, portIds) => {
          if (portIds) {
            this.hub.send(portIds, { type: 'session.removed', sessionId })
            return
          }
          this.hub.broadcast({ type: 'session.removed', sessionId })
          this.sendFolders()
        },
        ended: (sessionIds) => options.send({ type: 'host:sessions-ended', sessionIds }),
        returned: (sessionId, portIds) => {
          if (portIds) this.hub.send(portIds, { type: 'session.returned', sessionId })
          else this.hub.broadcast({ type: 'session.returned', sessionId })
        },
        viewers: (sessionId, showing, to) => {
          for (const portId of to) {
            const viewers = this.hub.viewers(showing, portId)
            this.hub.send([portId], { type: 'session.viewers', sessionId, viewers })
          }
        },
        attention: (sessionId, kind, title, body, request, facts) => {
          if (kind === 'error') this.sessionFailed(sessionId)
          if (kind !== 'turn-ended' && this.pluginHooks.wants('session.needsUser')) {
            this.pluginHooks.emit('session.needsUser', this.sessions.summary(sessionId), {
              reason: kind,
            })
          }
          this.attend(
            {
              type: 'host:attention',
              sessionId,
              kind,
              title,
              body,
              ...(request?.allow
                ? { allowOnce: { requestId: request.id, optionId: request.allow.optionId } }
                : {}),
              ...(request ? { request } : {}),
              front: this.front(sessionId),
            },
            facts,
          )
        },
        badge: (count) => options.send({ type: 'host:badge', count }),
        waiting: (sessions) => options.send({ type: 'host:waiting', sessions }),
        seen: (sessionId) => options.send({ type: 'host:seen', sessionId }),
        busy: (counts) => options.send({ type: 'host:busy-changed', ...counts }),
        completed: () => void this.star.turnCompleted(),
      },
    })
    this.routines = new RoutinesManager({
      userDataPath: options.userDataPath,
      file: routinesFile(options.userDataPath, log),
      threads: this.threads,
      sessions: {
        createRun: (params) => this.sessions.createRun(params),
        cancel: (sessionId) => this.sessions.cancel(sessionId),
        delete: (sessionId) => this.sessions.delete(sessionId),
        has: (sessionId) => this.sessions.has(sessionId),
        summary: (sessionId) =>
          this.sessions.has(sessionId) ? this.sessions.summary(sessionId) : null,
      },
      agents: {
        limits: (agentId) => this.agents.limitsOf(agentId),
        modelOption: (agentId) =>
          this.agentOptions.get(agentId)?.config.find((option) => option.category === 'model'),
        readLimits: (agentId) => this.agents.refreshLimits(agentId),
        name: (agentId) => this.agents.name(agentId),
      },
      log,
      resolveProject: (value) => this.projects.resolveDirectory(value),
      timings: options.routineTimings,
      ...(options.routineClock ? { clock: options.routineClock } : {}),
      events: {
        changed: (routine) => this.broadcast({ type: 'routine.changed', routine }),
        removed: (routineId) => this.broadcast({ type: 'routine.removed', routineId }),
        run: (run) => this.broadcast({ type: 'routine.run', run }),
        working: (working) => options.send({ type: 'host:routines-working', working }),
        attention: (kind, sessionId, title, body) =>
          this.attend({
            type: 'host:attention',
            sessionId,
            kind,
            title,
            body,
            front: this.front(sessionId),
          }),
        paused: (agentId, title, body) =>
          this.attend({ type: 'host:attention', kind: 'routine-paused', agentId, title, body }),
      },
    })
    routineHooks.current = this.routines.hooks
    const threads = this.threads
    this.tasks = new TaskEngine({
      store: threads
        ? {
            put: (task) => threads.task('put', { task }),
            all: () => threads.task('all', undefined),
            remove: (taskId) => threads.task('remove', { taskId }),
          }
        : { put: async () => null, all: async () => [], remove: async () => null },
      library: this.workflowLibrary,
      sessions: {
        createStep: (params) => this.sessions.createStep(params),
        send: (sessionId, text, due) => this.sessions.sendFromKettu(sessionId, text, due),
        cancel: (sessionId) => this.sessions.cancel(sessionId),
        delete: (sessionId) => this.sessions.delete(sessionId),
        has: (sessionId) => this.sessions.has(sessionId),
      },
      titleTask: (sessionId, text) => this.sessions.titleTask(sessionId, text),
      worktrees: {
        create: (projectPath, request, first) =>
          first
            ? this.sessions.createTaskWorktree(projectPath, request, first)
            : this.worktrees.create(projectPath, request),
        remove: async (projectPath, record, branch) => {
          const expected = await this.worktrees.inspect(projectPath, record)
          // Nothing the user was not shown is thrown away: a dirty worktree stays.
          if (expected.uncommitted > 0) return
          await this.worktrees.remove(projectPath, record, { branch, expected })
        },
      },
      git: createTaskGit(this.execRunner.exec),
      documents: {
        written: (artifactId, sessionId, since) =>
          this.documentWritten(artifactId, sessionId, since),
        openComments: async (artifactId) =>
          (await this.artifacts.threads(artifactId))
            .filter((thread) => thread.resolvedAt === null)
            .map((thread) => thread.comments.map((comment) => comment.body).join(' / ')),
      },
      resolveProject: (value) => this.projects.resolveDirectory(value),
      agents: () =>
        workflowAgents({
          statuses: this.agents.statuses(),
          options: (agentId) => this.agentOptions.get(agentId),
          catalog: this.catalog,
          marketplace: this.settings.marketplace,
        }),
      roleHint: async (ref) => {
        const role = await this.roles.get(ref)
        return role ? { name: role.title, suggests: role.suggests } : null
      },
      optionsOf: (pick) => optionsOfPick(this.agentOptions.get(pick.agentId), pick),
      pickOf: (agentId, values) => pickOfOptions(this.agentOptions.get(agentId), agentId, values),
      events: {
        changed: (task) => this.broadcast({ type: 'task.changed', task }),
        removed: (taskId) => this.broadcast({ type: 'task.removed', taskId }),
        attention: (task, kind) => this.taskAttention(task, kind),
        step: (event, info) =>
          this.pluginHooks.emit(event === 'started' ? 'task.stepStarted' : 'task.stepEnded', null, {
            task: {
              id: info.taskId,
              title: info.title,
              workflow: info.workflowName,
              project: info.projectPath,
            },
            step: {
              id: info.stepId,
              name: info.stepName,
              round: info.round,
              agent: info.agentId,
              outcome: info.outcome,
            },
          }),
        ended: (view, written) => void this.taskEnded(view, written),
      },
      workingLimit: () => this.settings.workflow.maxWorkingSteps,
      pullRequests: (sessionIds) =>
        sessionIds.flatMap((id) =>
          this.sessions.has(id) ? (this.sessions.summary(id).prs ?? []).map((pr) => pr.url) : [],
        ),
      log,
    })
    taskHooks.current = this.tasks
    const taskGit = createTaskGit(this.execRunner.exec)
    this.workflowSuggestions = new WorkflowSuggestions({
      file: suggestionsFile(options.userDataPath, log),
      dir: path.join(options.userDataPath, 'workflow-cards'),
      library: this.workflowLibrary,
      market: {
        workflows: () => this.marketCommunity.publicWorkflows(),
        text: (listingId, version) => this.marketCommunity.workflowText(listingId, version),
        add: (listing, text) => this.marketCommunity.addWorkflowVersion(listing, text),
      },
      tools: {
        kept: () => this.settings.marketplace,
        connected: (serverId) => this.marketConnections.view()[serverId]?.state === 'connected',
        resolve: (kind, ref) => this.marketTool(kind, ref),
        install: (tool) => this.installMarketTool(tool),
      },
      tasks: {
        start: (params, from, given) => this.tasks.start(params, from, given),
        pastRuns: (workflowId) => this.tasks.pastRuns(workflowId),
        draftIds: () => this.tasks.draftIds(),
      },
      sessions: {
        agentOf: (sessionId) => this.sessions.sessionAgent(sessionId),
        projectOf: (sessionId) => this.sessions.sessionProject(sessionId),
        tell: (sessionId, text) => this.sessions.sendCardAnswer(sessionId, text),
      },
      isRepo: (projectPath) => taskGit.isRepo(projectPath),
      changed: (suggestion) => {
        this.broadcast({ type: 'workflows.suggestion', suggestion })
        if (this.sessions.has(suggestion.sessionId))
          this.sessions.cardsChanged(suggestion.sessionId)
      },
      log,
    })
    this.consents = new ArtifactConsents({
      store: this.artifacts,
      isDevice: (portId) => this.hub.deviceOf(portId) !== null,
      send: (portIds, event) => this.hub.send(portIds, event),
      broadcast: (event) => this.hub.broadcast(event),
      agentName: async (folder) => (await this.sampleAgent(this.projectOf(folder)))?.name ?? null,
    })
    registerCapability(dbCapability(this.artifactData))
    registerCapability(filesCapability(platform))
    registerCapability(
      sampleCapability({
        agentFor: (project) => this.sampleAgent(project),
        answer: (agent, question) => this.answerQuestion(agent, question),
      }),
    )
    this.runtimeRequests = new RuntimeRequests(
      new RuntimeDispatcher({
        artifact: (id) => this.declaredArtifact(id),
        project: (folder) => this.projectOf(folder),
        allowed: (id, capability) => this.consents.allowed(id, capability),
        ask: (artifact, capability, client, waitMs) =>
          this.consents.ask(artifact, capability, client, waitMs),
        log,
      }),
    )
    this.deviceBrowser = new DeviceBrowserCalls({
      send: (portId, event) => this.hub.send([portId], event),
      servicePort: () => this.artifactService.listeningPort,
    })
    this.hub = new PortHub({
      handlers: this.handlers(),
      validators: createValidators(platform),
      closed: (portId) => this.portClosed(portId),
      log,
    })
    this.projects.onChange((projects, noProject) => {
      this.broadcast({ type: 'projects.changed', projects, noProject })
      this.sendFolders()
      this.system.forgetMounts()
    })
    this.env.onChange((info) => {
      this.broadcast({ type: 'environment.changed', info })
      this.git?.setEnvironment(this.env.agentEnv() as NodeJS.ProcessEnv)
    })
    // As Reload does: the fallback's PATH may have missed programs the login shell's finds.
    this.env.onRecovered(() => {
      void (async () => {
        await this.agents.redetect()
        if (this.git) await this.gitCall((g) => g.reloadTools())
      })().catch((error: unknown) =>
        log('warn', `Could not detect the agents again: ${(error as Error).message}`),
      )
    })
    this.git =
      typeof options.git === 'function'
        ? options.git({
            env: this.env.agentEnv() as NodeJS.ProcessEnv,
            log: (level, message) => log(level, `git: ${message}`),
          })
        : (options.git ?? null)
    if (this.git) this.wireGit(this.git)
  }

  /** Loads the state, answers `host:ready`, and resolves the environment in the background. */
  static async start(options: HostOptions): Promise<AgentHost> {
    await moveHarnessInstalls(
      path.join(options.userDataPath, 'agents'),
      harnessesFolder(options),
      (message) => writeLog('warn', 'host', message),
    )
    const host = new AgentHost(options)
    const [, , , remembered, updates, listing, manifest] = await Promise.all([
      host.scratch.ready(),
      host.projects.load(),
      host.sessions.load(),
      host.remembered.load(),
      host.updates.load(),
      host.registryListing.load(),
      host.harnessManifest.load(),
      host.trees.load(),
      host.agentOptions.load(),
      host.preparedRecords.load(),
      host.attachments.load(),
      host.artifactService.start(),
      host.routines.load(),
      host.memory.load(),
      host.workflowLibrary.load(),
      host.plugins.load(),
      host.workflowSuggestions.load(),
    ])
    // After the sessions, whose step sessions it messages when it resumes.
    await host.tasks.load()
    // After the tasks, whose drafts keep their texts.
    await host.workflowSuggestions.sweep()
    host.agents.restore(remembered)
    host.agents.restoreRegistry(listing)
    host.agents.restoreManifest(manifest)
    host.agents.restoreUpdates(updates)
    host.routines.start()
    void host.marketSkills.sync()
    host.plugins.start()
    host.pluginScripts.sync(host.plugins.scripts())
    void host.pluginThemes.sync()
    host.sendFolders()
    void host.sessions.checkWorktrees()
    host.usage.start()
    host.artifacts.start()
    host.idleRelease.start()
    options.send({ type: 'host:service-port', port: host.artifactService.listeningPort })
    options.send({ type: 'host:ready' })
    void host.trees.stopLeftovers()
    host.agents.startLimitReads()
    void host.agents.removeAntigravityUsageServer()
    void host.agents.detectAll().then(() => {
      host.agents.scheduleUpdateChecks()
      host.agents.scheduleRegistryReads()
      host.firstStart()
    })
    return host
  }

  /**
   * The first start of this host: names the programs it found for the settings' owner to add
   * their agents. A host whose login shell could not be read waits for the next start, since
   * the programs on its `PATH` may be missing.
   */
  private firstStart(): void {
    if (this.settings.initialSetupDone || this.env.info().source === 'fallback') return
    this.options.send({ type: 'host:first-start', harnesses: this.agents.userPrograms() })
  }

  /** The Claude Code agents of this host and their configuration folders, for memory's import. */
  private claudeAgents(): { agentId: AgentId; name: string; configDir: string }[] {
    return this.agents.ids().flatMap((agentId) => {
      if (harnessOf(agentId) !== 'claude-code') return []
      const configDir = this.agents.configFolder(agentId)
      return configDir ? [{ agentId, name: this.agents.name(agentId), configDir }] : []
    })
  }

  private wireGit(git: GitServiceApi): void {
    git.setBackgroundFetch(this.settings.git.backgroundFetch)
    this.gitUnsubscribe = [
      git.onChanged((status) =>
        this.sendToRetainers(status.projectPath, { type: 'git.changed', status }),
      ),
      git.onPullRequest((projectPath, pr) =>
        this.sendToRetainers(projectPath, { type: 'git.pr', projectPath, pr }),
      ),
      git.onTools((tools) => {
        this.broadcast({ type: 'git.tools', tools })
        this.star.recheck()
      }),
      git.onBranchPullRequests((projectPath) => this.sessions.pullRequestsChanged(projectPath)),
      git.onReferenceChanged((url, found) => {
        this.hub.send(git.referenceWatchers(url), { type: 'git.reference', url, found })
        if (found.kind === 'pull') this.sessions.pullRequestLoaded(found.pullRequest.url)
      }),
      git.onSessionEvents((sessionId, events) => this.sessions.gitEvents(sessionId, events)),
    ]
  }

  /**
   * The folders terminals may open in, sent when they change: the projects, scratch folders and
   * sessions' worktrees.
   */
  private sendFolders(): void {
    const paths = [...this.projects.paths(), ...this.sessions.sessionFolders()]
    const key = paths.join('\n')
    if (key === this.sentFolders) return
    this.sentFolders = key
    this.options.send({ type: 'host:projects', paths })
  }

  private broadcast(event: HostEvent): void {
    this.hub.broadcast(event)
  }

  /** The workflow settings: suggestions, and which Claude Code and Codex agents Auto may pick. */
  private workflowSettings(): WorkflowSettings {
    const agents = this.agents
      .statuses()
      .filter((status) => STEP_HARNESSES.has(status.harnessId) && status.registered !== false)
      .filter((status) => status.disabled !== true && status.uninstalled !== true)
      .map((status) => {
        const apiKey = status.account?.kind === 'api_key' || status.apiKey?.set === true
        return { agentId: status.id, ...this.workflowLibrary.autoPick(status.id, apiKey) }
      })
    return { suggest: this.workflowLibrary.suggest, agents }
  }

  /** Whether `sessionId` wrote a version of the document artifact at or after `since`. */
  private async documentWritten(
    artifactId: string,
    sessionId: string,
    since: number,
  ): Promise<WrittenDocument> {
    let found
    try {
      found = await this.artifacts.get(artifactId)
    } catch {
      return { ok: false, why: 'not_found' }
    }
    if (found.type?.name !== 'document') return { ok: false, why: 'not_document' }
    const versions = await this.artifacts.versions(artifactId)
    const own = versions.find((v) => v.author === sessionId && v.createdAt >= since)
    if (!own) return { ok: false, why: 'not_written' }
    return { ok: true, version: found.version.version, title: found.artifact.title }
  }

  /**
   * A task's notification, which opens the task whether or not any step has a session; devices,
   * which open sessions, get it through its latest step's session.
   */
  private taskAttention(task: TaskSummary, kind: 'needs-you' | 'ended'): void {
    const steps = [...task.steps].reverse()
    const step = steps.find((s) => s.state === 'needs_you' || s.state === 'error')
    const sessionId = step?.sessionId ?? steps.find((s) => s.sessionId !== null)?.sessionId
    const title =
      kind === 'needs-you'
        ? t('tasks.needsYou', { title: task.title })
        : task.status === 'cancelled'
          ? t('tasks.cancelled', { title: task.title })
          : task.end === 'done'
            ? t('tasks.done', { title: task.title })
            : t('tasks.dropped', { title: task.title })
    const body =
      kind === 'needs-you'
        ? t('tasks.needsYouBody', { step: step?.name ?? '', workflow: task.workflowName })
        : t('tasks.endedBody', { workflow: task.workflowName, steps: task.steps.length })
    this.attend({
      type: 'host:attention',
      kind: kind === 'needs-you' ? 'task-needs-you' : 'task-ended',
      taskId: task.id,
      title,
      body,
      ...(sessionId ? { sessionId, front: this.front(sessionId) } : {}),
    })
  }

  /** What a status changed in the agent's plan limit windows, said as notices. */
  private limitsNoticed(status: AgentStatus): void {
    for (const notice of this.limitNotices.observe(status, Date.now())) {
      // A used-up window waits a moment for the turn it stopped to fail, so the two say it once.
      if (notice.level === 'reached') setTimeout(() => this.sendLimitNotice(notice), LIMIT_MERGE_MS)
      else this.sendLimitNotice(notice)
    }
  }

  private sessionFailed(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    this.lastFailed.set(this.sessions.summary(sessionId).agentId, { sessionId, at: Date.now() })
  }

  /** Tells main, which shows the notice and pushes it to devices, then the plugin channels. */
  private attend(
    message: Extract<HostToMain, { type: 'host:attention' }>,
    facts?: RequestFacts,
  ): void {
    this.options.send(message)
    try {
      this.pluginChannels.notice(message, facts)
    } catch (error) {
      writeLog(
        'warn',
        'plugins',
        `A notice could not go to the channels: ${(error as Error).message}`,
      )
    }
  }

  private sendLimitNotice(notice: LimitNotice): void {
    const now = Date.now()
    let sessionId: string | undefined
    if (notice.level === 'reached') {
      const failed = this.lastFailed.get(notice.agentId)
      if (failed && now - failed.at < LIMIT_FAILED_WITHIN_MS) {
        sessionId = failed.sessionId
        this.stoppedBy.set(notice.key, sessionId)
        if (this.sessions.has(sessionId)) {
          this.sessions.turnLimited(sessionId, this.agents.status(notice.agentId), notice.limit)
        }
      }
    } else if (notice.level === 'reset') {
      sessionId = this.stoppedBy.get(notice.key)
      this.stoppedBy.delete(notice.key)
    }
    const summary =
      sessionId && this.sessions.has(sessionId) ? this.sessions.summary(sessionId) : null
    const { title, body } = limitNoticeText(notice, summary?.title ?? null, now)
    this.attend({
      type: 'host:attention',
      kind: 'plan-limit',
      agentId: notice.agentId,
      level: notice.level,
      key: notice.key,
      usedPercent: notice.limit.usedPercent,
      ...(summary ? { sessionId: summary.id } : {}),
      title,
      body,
    })
  }

  /** A task that ended tells the conversation it started from what it delivered. */
  private async taskEnded(view: TaskView, written: boolean): Promise<void> {
    const from = view.from
    if (!from) return
    const writtenBy = written
      ? (this.workflowSuggestions.draftAgent(view.workflowId) ??
        this.sessions.sessionAgent(from.sessionId))
      : null
    try {
      await this.sessions.taskDelivered(from.sessionId, deliveryOf(view, writtenBy, Date.now()))
    } catch (error) {
      this.diagnostics.log('warn', `Could not deliver task ${view.id}: ${(error as Error).message}`)
    }
  }

  /** Save as my workflow, on a task that ran on a workflow its agent wrote for it and ended done. */
  private async saveTaskWorkflow(taskId: string): Promise<WorkflowEntry> {
    const draft = this.tasks.writtenDraft(taskId)
    if (!draft) throw new HostError('conflict', t('tasks.notWritten'))
    return this.workflowSuggestions.saveDraft(draft)
  }

  /** Where a task's workflow is kept while it is published, as the Marketplace tools write it. */
  private taskPublishFolder(taskId: string): string {
    return path.join(this.options.userDataPath, 'workflows-to-publish', taskId)
  }

  /**
   * Publish to the Marketplace: the agent of the conversation the task started from gets the
   * task's workflow and is asked to make it general and publish it, handing the text back to the
   * Marketplace tools, so it writes no file of its own.
   */
  private async publishTaskWorkflow(taskId: string): Promise<void> {
    const draft = this.tasks.writtenDraft(taskId)
    if (!draft) throw new HostError('conflict', t('tasks.notWritten'))
    const view = this.tasks.get(taskId)
    const sessionId = view.from?.sessionId
    if (!sessionId || !this.sessions.has(sessionId)) throw notFound(t('tasks.noOrigin'))
    // The agent's general version is kept when the user asks again.
    const kept = await readFile(
      path.join(this.taskPublishFolder(taskId), 'workflow.yaml'),
      'utf8',
    ).catch(() => null)
    const own = await this.workflowSuggestions.draftText(draft)
    const general = kept !== null && kept !== own
    await this.sessions.sendCardAnswer(
      sessionId,
      publishWorkflowPrompt(view, general ? kept : own, general),
    )
    const entry = await this.sessions.taskDelivery(sessionId, taskId)
    if (entry) this.sessions.taskPublishAsked(sessionId, entry.id)
  }

  /** Who shows a session in front now: any window or device, and which devices. */
  private front(sessionId: string): AttentionFront {
    const ports = this.sessions.showing(sessionId)
    const devices = ports.flatMap((portId) => this.hub.deviceOf(portId)?.id ?? [])
    return { any: ports.length > 0, devices: [...new Set(devices)] }
  }

  private sendToRetainers(projectPath: string, event: HostEvent): void {
    this.hub.send(this.gitRetains.ports(pathKey(projectPath, this.options.platform)), event)
  }

  private reportProcesses(processes: AgentProcess[]): void {
    const json = JSON.stringify(processes)
    if (json === this.lastProcesses) return
    this.lastProcesses = json
    this.options.send({ type: 'host:agent-processes', processes })
  }

  /** Serves a window's port, or a paired device's when `device` names it. */
  connect(channel: PortChannel<FromPort<HostEvent>>, device: PortDevice | null = null): string {
    return this.hub.add(channel, device)
  }

  /** `host:battery`: whether the computer runs on battery, which main reads on Windows. */
  battery(onBattery: boolean): void {
    this.onBattery = onBattery
  }

  private portClosed(portId: string): void {
    this.load.portClosed(portId)
    this.runtimeRequests.portClosed(portId)
    this.consents.portClosed(portId)
    this.deviceBrowser.portClosed(portId)
    this.browserTurns.portClosed(portId)
    this.sessions.portClosed(portId)
    this.artifacts.portClosed(portId)
    this.gitRetains.dropPort(portId)
    this.git?.releaseAll(portId)
  }

  /** `host:settings`: binary overrides, the proxy and background fetch, applied live. */
  async updateSettings(next: HostSettings): Promise<void> {
    const previous = this.settings
    this.settings = next
    if (setLocale(next.locale)) {
      this.broadcast({ type: 'environment.changed', info: this.env.info() })
      this.pluginEvent('app.locale', { locale: next.locale })
    }
    if (JSON.stringify(previous.proxy) !== JSON.stringify(next.proxy)) {
      this.env.setProxy(next.proxy)
      this.git?.setEnvironment(this.env.agentEnv() as NodeJS.ProcessEnv)
    }
    if (previous.git.backgroundFetch !== next.git.backgroundFetch) {
      this.git?.setBackgroundFetch(next.git.backgroundFetch)
    }
    this.usage.setFromComputer(next.usage.fromComputer)
    if (JSON.stringify(previous.computerUse) !== JSON.stringify(next.computerUse)) {
      this.computer?.settingsChanged()
    }
    this.env.setConfigFolders(configFolders(this.catalog, next))
    this.startModesChanged(previous, next)
    if (JSON.stringify(previous.idleSessions) !== JSON.stringify(next.idleSessions)) {
      this.idleRelease.notify()
    }
    if (previous.workflow.maxWorkingSteps !== next.workflow.maxWorkingSteps) {
      this.tasks.limitChanged()
    }
    if (previous.continueAfterLimit !== next.continueAfterLimit) {
      this.sessions.continueSettingChanged(next.continueAfterLimit)
    }
    // A step held for a tool the host lacked may start once it is installed and on.
    if (JSON.stringify(previous.marketplace) !== JSON.stringify(next.marketplace)) {
      this.tasks.recheck()
    }
    this.marketChanged(previous.marketplace.mcp, this.marketKeys)
    if (JSON.stringify(previous.marketplace.mcp) !== JSON.stringify(next.marketplace.mcp)) {
      void this.marketBundles.sweep()
    }
    if (JSON.stringify(previous.marketplace.skills) !== JSON.stringify(next.marketplace.skills)) {
      void this.skillsChanged(previous.marketplace.skills)
    }
    this.countCommunity(previous.marketplace, next.marketplace)
    const removed = await this.agents.settingsChanged(previous, next)
    const turnedOff = next.disabledAgents.filter((id) => !previous.disabledAgents.includes(id))
    const gone = [...removed, ...turnedOff]
    if (gone.length > 0) await this.sessions.agentsRemoved(gone)
  }

  /** `host:market-account`: the Kettu account the Marketplace tools publish with, or none. */
  setMarketAccount(account: unknown): void {
    const value = account as Record<string, unknown> | null
    const before = this.marketAccount
    this.marketAccount =
      value !== null &&
      typeof value === 'object' &&
      typeof value.email === 'string' &&
      (value.name === null || typeof value.name === 'string')
        ? { name: value.name as string | null, email: value.email }
        : null
    if (JSON.stringify(before) !== JSON.stringify(this.marketAccount)) {
      this.hub.broadcast({ type: 'market.publishedChanged' })
    }
    if ((before === null) !== (this.marketAccount === null)) void this.ownSkillsChanged()
  }

  /**
   * A feature that decides Kettu's own skills and guide was turned on or off: Claude Code's
   * plugins follow, and the prepared sessions, which started with the old ones, are replaced.
   */
  private async ownSkillsChanged(): Promise<void> {
    await this.marketSkills.sync()
    this.sessions.libraryChanged(() => true)
  }

  /**
   * The Marketplace entry a workflow names a tool by, as its card shows it: a Kettu Marketplace
   * listing, an MCP Registry server or a skill of the catalog; null when there is none.
   */
  private async marketTool(kind: 'mcp' | 'skill', ref: string): Promise<SuggestedTool | null> {
    const listing = listingIdOf(ref)
    if (kind === 'mcp') {
      let server: CatalogServer | null
      if (listing) {
        const found = await this.marketCommunity.listing(listing)
        server =
          found.state === 'listed' && found.listing.kind === 'mcp-server' ? found.server : null
      } else {
        server = (await this.marketCatalog.search(ref)).items.find((s) => s.id === ref) ?? null
      }
      if (!server) return null
      const setup =
        server.spec.type === 'http' && server.spec.oauth
          ? 'sign-in'
          : specInputs(server.spec).some((input) => input.required)
            ? 'keys'
            : 'none'
      return {
        kind,
        ref,
        title: server.title,
        description: server.description || null,
        server,
        skill: null,
        setup,
      }
    }
    if (listing) {
      const found = await this.marketCommunity.listing(listing)
      if (found.state !== 'listed' || found.listing.kind !== 'skill') return null
      return {
        kind,
        ref,
        title: found.listing.name,
        description: found.listing.description || null,
        server: null,
        skill: { kind: 'kettu', id: listing },
        setup: 'none',
      }
    }
    const skill = (await this.marketSkills.skills()).catalog.find((s) => s.id === ref)
    if (!skill) return null
    return {
      kind,
      ref,
      title: skill.name,
      description: skill.description || null,
      server: null,
      skill: { kind: 'catalog', id: ref },
      setup: 'none',
    }
  }

  /**
   * Installs a tool a workflow card's Start names, for every agent as the Marketplace installs by
   * default, or turns on the one Kettu keeps off. The change is an edit of the list its owner
   * holds, so it never writes over another install made meanwhile.
   */
  private async installMarketTool(tool: SuggestedTool): Promise<void> {
    const { marketplace } = (await this.settingsCall({ kind: 'read' })).file
    if (tool.kind === 'skill') {
      const own = keptTool(marketplace.skills, tool.ref)
      if (own?.on) return
      let entry: MarketSkill
      if (own) {
        entry = { ...own, on: true }
      } else {
        if (!tool.skill) throw notFound(t('workflow.toolGone', { name: tool.title }))
        entry = { ...(await this.marketSkills.add(tool.skill)), agents: 'all', on: true }
      }
      await this.settingsCall({
        kind: 'change',
        patch: { marketplace: { skillsEdit: { put: [entry] } } },
      })
      return
    }
    const own = keptTool(marketplace.mcp, tool.ref)
    if (own?.on) return
    let entry: MarketServer
    if (own) {
      entry = { ...own, on: true }
    } else {
      const server = tool.server
      if (!server) throw notFound(t('workflow.toolGone', { name: tool.title }))
      const kettu = listingIdOf(server.id) !== null
      entry = {
        id: server.id,
        name: serverName(kettu ? server.title : server.id, marketplace.mcp),
        title: server.title,
        source: kettu ? 'kettu' : 'registry',
        version: server.version,
        spec: server.spec,
        agents: 'all',
        on: true,
      }
    }
    await this.settingsCall({
      kind: 'change',
      patch: { marketplace: { mcpEdit: { put: [entry] } } },
    })
  }

  /** Makes a Marketplace API call through main or the daemon, which hold the access token. */
  private marketCall<K extends MarketCall['kind']>(
    call: Extract<MarketCall, { kind: K }>,
  ): Promise<MarketResults[K]> {
    const callId = this.nextMarketCall++
    return new Promise<MarketCallAnswer>((resolve) => {
      this.marketCalls.set(callId, resolve)
      this.options.send({ type: 'host:market-call', callId, call })
    }).then((answer) => {
      if ('error' in answer) throw new MarketCallError(answer.error)
      return answer.result as MarketResults[K]
    })
  }

  /** A first publish's publisher name; a name the service refuses keeps the card waiting. */
  private async setPublisher(handle: string): Promise<void> {
    if (!HANDLE.test(handle))
      throw new HostError('invalid_params', t('marketPublish.handleInvalid'))
    try {
      await this.marketTools.setPublisher(handle)
    } catch (error) {
      if (!(error instanceof MarketCallError)) throw error
      const { code, message } = error.failure
      if (code === 'handle_taken') {
        throw new HostError('conflict', t('marketPublish.handleTaken', { handle }))
      }
      if (code === 'invalid_request') {
        throw new HostError('invalid_params', t('marketPublish.handleInvalid'))
      }
      throw new HostError('unavailable', t('marketPublish.publisherFailed', { reason: message }))
    }
  }

  /** Moves the paths to the system's trash, which only main reaches; the daemon has none. */
  private async trash(paths: string[]): Promise<void> {
    const callId = this.nextTrashCall++
    const error = await new Promise<string | null>((resolve) => {
      this.trashCalls.set(callId, resolve)
      this.options.send({ type: 'host:trash-call', callId, paths })
    })
    if (error !== null) throw new HostError('unavailable', error)
  }

  /** `trash-result`: main's or the daemon's answer to a trash call. */
  trashResult(callId: number, error: string | null): void {
    const resolve = this.trashCalls.get(callId)
    if (!resolve) return
    this.trashCalls.delete(callId)
    resolve(error)
  }

  /** Reads or changes the settings through main or the daemon, which keep the file. */
  private settingsCall(call: SettingsCall): Promise<SettingsSnapshot> {
    const callId = this.nextSettingsCall++
    return new Promise<SettingsCallAnswer>((resolve) => {
      this.settingsCalls.set(callId, resolve)
      this.options.send({ type: 'host:settings-call', callId, call })
    }).then((answer) => {
      if ('error' in answer) throw new Error(answer.error)
      return answer.result
    })
  }

  /** `settings-result`: main's or the daemon's answer to a settings call. */
  settingsResult(callId: number, answer: SettingsCallAnswer): void {
    const resolve = this.settingsCalls.get(callId)
    if (!resolve) return
    this.settingsCalls.delete(callId)
    resolve(answer)
  }

  /** What the settings tools read of the host itself: its agents and harnesses, and their facts. */
  private async settingsLocal(): Promise<LocalFacts> {
    const statuses = this.agents
      .statuses()
      .filter((status) => status.registered !== false && status.uninstalled !== true)
    const facts: SettingFacts = {}
    const modes: Partial<Record<AgentId, { value: string; name: string }[]>> = {}
    for (const status of statuses) {
      const account = status.account
      facts[`agents.account:${status.id}`] =
        account && account.kind !== 'none'
          ? [account.label, account.email].filter(Boolean).join(' · ') || null
          : null
      // Only whether a key is set; its value stays where Kettu keeps it.
      facts[`agents.api-key:${status.id}`] = status.apiKey ? status.apiKey.set : null
      if (takesStartMode(status.id)) {
        const option = this.agentOptions
          .get(status.id)
          ?.config.find((o) => o.category === 'mode' && o.type === 'select' && !!o.choices?.length)
        if (option?.choices) {
          modes[status.id] = option.choices.map((choice) => ({
            value: choice.value,
            name: choice.name,
          }))
        }
      }
    }
    const harnesses = new Map(statuses.map((s) => [s.harnessId, s.harnessName]))
    facts['agents.agents'] = statuses.length
    facts['harnesses.installed'] = harnesses.size
    facts['archived.sessions'] = this.sessions
      .summaries()
      .filter((summary) => summary.archivedAt !== null).length
    facts['memory.enabled'] = this.memory.enabled
    facts['agents.workflow-suggest'] = this.workflowLibrary.suggest
    try {
      facts['artifacts.page-permissions'] = (await this.consents.list()).length
    } catch {
      // Unread lists go without a count.
    }
    try {
      await this.deviceAccess.ready
      facts['devices.allowed-devices'] = this.deviceAccess.list().length
    } catch {
      // As above.
    }
    const plugins: CatalogPlugin[] = []
    for (const plugin of await this.plugins.list()) {
      const { contents } = plugin
      if (contents.settings.length === 0) continue
      plugins.push({
        id: plugin.id,
        title: pluginText(contents.titles, contents.title, this.settings.locale),
        settings: contents.settings.map((setting) => ({
          key: setting.key,
          type: setting.type,
          title: setting.title,
          ...(setting.description ? { description: setting.description } : {}),
          ...(setting.options ? { options: setting.options } : {}),
        })),
      })
      for (const setting of contents.settings) {
        const row = `${plugin.id}:${setting.key}`
        // A secret only as whether it is set.
        if (setting.type === 'secret') {
          facts[toolId('plugins.secret', row)] = (plugin.secretsSet ?? []).includes(setting.key)
        } else {
          const id =
            setting.type === 'boolean'
              ? 'plugins.switch'
              : setting.type === 'select'
                ? 'plugins.choice'
                : 'plugins.text'
          facts[toolId(id, row)] = plugin.values?.[setting.key] ?? null
        }
      }
    }
    return {
      agents: statuses.map((status) => ({
        id: status.id,
        name: status.name,
        harnessId: status.harnessId,
      })),
      harnesses: [...harnesses].map(([id, name]) => ({ id, name })),
      modes,
      plugins,
      facts,
    }
  }

  /**
   * open_settings: Settings opens at the row in the desktop windows that show the session, a
   * desktop app connected as a device included; a row of the desktop app's own only in this
   * computer's windows. False when no such window shows it.
   */
  private openSettings(sessionId: string, target: SettingsTarget): boolean {
    const ports = this.sessions.showing(sessionId).filter((portId) => {
      const device = this.hub.deviceOf(portId)
      return device === null || (!target.desktop && device.browser === true)
    })
    if (ports.length === 0) return false
    this.hub.send(ports, {
      type: 'settings.open',
      section: target.section,
      item: target.item,
      row: target.row,
    })
    return true
  }

  /** Undo on a settings line: the rows go back, unless one changed again since. */
  private async undoSettings(sessionId: string, entryId: string): Promise<void> {
    const items = this.sessions.settingsChange(sessionId, entryId)
    try {
      await this.settingsTools.undo(items)
    } catch (error) {
      if (error instanceof StaleUndo) {
        this.sessions.settingsSettled(sessionId, entryId, { kind: 'changed', stale: true })
        throw new HostError('conflict', error.message)
      }
      throw new HostError('unavailable', (error as Error).message)
    }
    this.sessions.settingsSettled(sessionId, entryId, { kind: 'changed', undone: true })
  }

  /** `market-result`: main's or the daemon's answer to a Marketplace call. */
  marketResult(callId: number, answer: MarketCallAnswer): void {
    const resolve = this.marketCalls.get(callId)
    if (!resolve) return
    this.marketCalls.delete(callId)
    resolve(answer)
  }

  /**
   * `host:market-keys`: every value of the Marketplace servers' inputs, replacing those before.
   * They stay in memory and go only into what agents are handed; a malformed message is dropped.
   */
  setMarketKeys(
    values: unknown,
    oauth?: unknown,
    agentEnv?: unknown,
    pluginSecrets?: unknown,
  ): void {
    const keys = parseMarketKeys(values)
    const signIns = oauth === undefined ? undefined : parseSignIns(oauth)
    if (!keys || signIns === null) {
      this.diagnostics.log('warn', 'host:market-keys was not a map of values; ignored')
      return
    }
    const previous = this.marketKeys
    this.marketKeys = keys
    const previousAgentEnv = this.agentEnvKeys
    if (typeof agentEnv === 'object' && agentEnv !== null && !Array.isArray(agentEnv)) {
      this.agentEnvKeys = Object.fromEntries(
        Object.entries(agentEnv).flatMap(([id, vars]) =>
          typeof vars === 'object' && vars !== null && !Array.isArray(vars)
            ? [
                [
                  id,
                  Object.fromEntries(
                    Object.entries(vars).filter(
                      (entry): entry is [string, string] => typeof entry[1] === 'string',
                    ),
                  ),
                ],
              ]
            : [],
        ),
      )
    }
    for (const agentId of new Set([
      ...Object.keys(previousAgentEnv),
      ...Object.keys(this.agentEnvKeys),
    ])) {
      if (
        JSON.stringify(previousAgentEnv[agentId] ?? {}) !==
        JSON.stringify(this.agentEnvKeys[agentId] ?? {})
      ) {
        void this.agents.agentEnvChanged(agentId as AgentId).catch((error: unknown) => {
          this.diagnostics.log(
            'warn',
            `Could not restart ${agentId} after its key changed: ${(error as Error).message}`,
          )
        })
      }
    }
    this.marketChanged(this.settings.marketplace.mcp, previous)
    if (signIns) this.signInsPushed(signIns)
    this.hub.broadcast({ type: 'market.keysChanged' })
    const secrets = parseMarketKeys(pluginSecrets ?? {})
    if (secrets) {
      const held = Object.fromEntries(
        [...secrets].map(([id, inputs]) => [id, Object.fromEntries(inputs)]),
      )
      if (JSON.stringify(held) !== JSON.stringify(this.pluginSecrets)) {
        this.pluginSecrets = held
        this.hub.broadcast({ type: 'plugins.changed' })
      }
    }
  }

  /**
   * Main's copy of the sign-ins. Every message to main is answered with one, so a sign-in two
   * pushes have not carried back was refused: it keeps working until the host restarts.
   */
  private signInsPushed(signIns: Record<string, string>): void {
    const before = this.marketConnections.view()
    this.marketConnections.load(signIns)
    for (const [serverId, sent] of this.unkept) {
      const kept = Object.hasOwn(signIns, serverId) ? signIns[serverId]! : null
      if (kept === sent.state) {
        this.unkept.delete(serverId)
      } else if (++sent.pushes >= 2) {
        this.unkept.delete(serverId)
        this.diagnostics.log(
          'warn',
          `Main did not keep the sign-in of ${serverId}; it lasts until the host restarts`,
        )
      }
    }
    const after = this.marketConnections.view()
    for (const [serverId, connection] of Object.entries(after)) {
      if (JSON.stringify(before[serverId]) !== JSON.stringify(connection)) {
        this.connectionChanged(serverId, connection)
      }
    }
  }

  /** Asks main to keep a server's sign-in, or to forget it with null. */
  private keepSignIn(serverId: string, state: string | null): void {
    this.unkept.set(serverId, { state, pushes: 0 })
    this.options.send({ type: 'host:market-oauth', serverId, state })
  }

  /**
   * A server's sign-in changed: the clients hear of it, and the prepared sessions of its agents
   * are replaced, since they started with the server or without it.
   */
  private connectionChanged(
    serverId: string,
    connection: MarketConnection,
    loginId?: string,
    error?: string,
  ): void {
    this.hub.broadcast({
      type: 'market.connectionChanged',
      serverId,
      connection,
      ...(loginId !== undefined ? { loginId } : {}),
      ...(error !== undefined ? { error } : {}),
    })
    const server = this.settings.marketplace.mcp.find((item) => item.id === serverId)
    if (server) this.sessions.libraryChanged((agentId) => serverFor(server, agentId))
  }

  /**
   * The Marketplace's servers or keys may have changed from `servers` and `keys`: each agent whose
   * servers differ now has its prepared sessions replaced.
   */
  private marketChanged(servers: HostSettings['marketplace']['mcp'], keys: MarketKeys): void {
    // Proxied servers compare by where they go, without a session's bearer.
    const oauth = {
      access: (server: MarketServer) => this.marketConnections.access(server),
      bearer: () => ({ origin: '', token: '' }),
    }
    const options = { platform: this.options.platform, oauth, node: this.options.nodeRuntime }
    const of = (list: typeof servers, held: MarketKeys, agentId: AgentId): string =>
      JSON.stringify(libraryServers(list, held, agentId, ALL_TRANSPORTS, options))
    const now = this.settings.marketplace.mcp
    if (servers === now && keys === this.marketKeys) return
    this.sessions.libraryChanged(
      (agentId) => of(servers, keys, agentId) !== of(now, this.marketKeys, agentId),
    )
  }

  /**
   * The skills in the settings changed from `before`: the disk follows, then the prepared sessions
   * of each agent whose skills differ are replaced.
   */
  private async skillsChanged(before: HostSettings['marketplace']['skills']): Promise<void> {
    await this.marketSkills.sync()
    const now = this.settings.marketplace.skills
    const of = (skills: typeof now, agentId: AgentId): string =>
      JSON.stringify(skills.filter((skill) => skillFor(skill, agentId)).map((s) => [s.id, s.name]))
    this.sessions.libraryChanged((agentId) => of(before, agentId) !== of(now, agentId))
  }

  /**
   * The skills and servers from the Kettu Marketplace that the settings now keep, or keep at
   * another version, are counted once each as an install or an update.
   */
  private countCommunity(
    before: HostSettings['marketplace'],
    after: HostSettings['marketplace'],
  ): void {
    const versions = (list: readonly { id: string; version: string | null }[]) =>
      new Map(
        list.flatMap((item) => {
          const id = listingIdOf(item.id)
          return id ? [[id, item.version] as const] : []
        }),
      )
    for (const kind of ['skills', 'mcp'] as const) {
      const was = versions(before[kind])
      for (const [id, version] of versions(after[kind])) {
        if (!was.has(id)) void this.marketCommunity.count(id, version, 'install')
        else if (was.get(id) !== version) void this.marketCommunity.count(id, version, 'update')
      }
    }
  }

  /** The agents of these harnesses that are turned on and whose program is installed. */
  private async installedAgents(
    harnesses: readonly HarnessId[],
    among: readonly AgentId[] = this.agents.ids(),
  ): Promise<AgentId[]> {
    const wanted = among.filter(
      (id) => harnesses.includes(harnessOf(id)) && !this.settings.disabledAgents.includes(id),
    )
    const found = await Promise.all(wanted.map((id) => this.agents.harnessProgram(id)))
    return wanted.filter((_, index) => found[index] !== null)
  }

  /** The agent's app-server for requests outside a session, started if it is not running. */
  private async appServer(agentId: AgentId): Promise<CodexRequest> {
    const { connection } = await this.agents.ensureReady(agentId)
    const request = connection.request?.bind(connection)
    if (!request) throw new HostError('agent_unavailable', t('hostError.agentNoRequest'))
    return request
  }

  /** The options as New session takes them, with the start mode the settings name for the agent. */
  private withStartMode(options: AgentOptions): AgentOptions {
    const startMode = startModeIn(this.settings, options.agentId)
    return startMode === undefined ? options : { ...options, startMode }
  }

  /**
   * An agent's start mode changed: its prepared sessions started in the old one, and the windows
   * learn the new one with its options, after the prepared sessions' removal.
   */
  private startModesChanged(previous: HostSettings, next: HostSettings): void {
    const agentIds = new Set([...Object.keys(previous.startModes), ...Object.keys(next.startModes)])
    for (const agentId of agentIds as Set<AgentId>) {
      if (startModeIn(previous, agentId) === startModeIn(next, agentId)) continue
      this.sessions.startModeChanged(agentId)
      const entry = this.agentOptions.get(agentId)
      if (entry) this.hub.broadcast({ type: 'agent.options', options: this.withStartMode(entry) })
    }
  }

  /** `host:color-mode`: the window's color mode, from main at start and whenever it changes. */
  setColorMode(mode: ColorMode): void {
    if (this.colorMode === mode) return
    this.colorMode = mode
    this.pluginEvent('app.colorMode', { colorMode: mode })
  }

  /** Tells every plugin whose script is loaded; one that is not loaded reads the value when it is. */
  private pluginEvent(name: (typeof PLUGIN_EVENTS)[number], payload: unknown): void {
    for (const plugin of this.pluginHost.status()) {
      if (plugin.state !== 'active') continue
      this.pluginHost.deliverEvent(plugin.id, name, payload).catch((error: unknown) => {
        writeLog(
          'warn',
          'plugins',
          `Could not tell ${plugin.id} of ${name}: ${(error as Error).message}`,
        )
      })
    }
  }

  /** A secret a plugin's script reads; null while it is not set. */
  private pluginSecret(pluginId: string, key: string): string | null {
    if (!this.plugins.declaresSecret(pluginId, key)) {
      throw new Error(t('plugins.noSecret', { key: key.slice(0, 100) }))
    }
    return this.pluginSecrets[pluginId]?.[key] ?? null
  }

  /** Sets or, with null, clears a secret of a plugin in the key store, which main or the daemon keeps. */
  async setPluginSecret(
    pluginId: string,
    key: string,
    value: string | null,
  ): Promise<InstalledKettuPlugin> {
    if (!this.plugins.declaresSecret(pluginId, key)) {
      throw new HostError('invalid_params', t('plugins.noSecret', { key }))
    }
    await this.askPluginSecret(pluginId, key, value)
    this.pluginSettingEvent(pluginId, key, true)
    return this.plugins.view(pluginId)
  }

  /** A removed plugin takes what it kept: its secrets and its storage. */
  private pluginRemoved(pluginId: string): void {
    this.pluginStorage.forget(pluginId)
    this.pluginChannels.forget(pluginId)
    if (this.pluginSecrets[pluginId] === undefined) return
    this.askPluginSecret(pluginId, null, null).catch((error: unknown) =>
      writeLog(
        'warn',
        'plugins',
        `Could not clear the secrets of ${pluginId}: ${(error as Error).message}`,
      ),
    )
  }

  private async askPluginSecret(
    pluginId: string,
    key: string | null,
    value: string | null,
  ): Promise<void> {
    const callId = this.nextPluginSecretCall++
    const error = await new Promise<string | null>((resolve) => {
      this.pluginSecretCalls.set(callId, resolve)
      this.options.send({ type: 'host:plugin-secret', callId, pluginId, key, value })
    })
    if (error !== null) throw new HostError('unavailable', `${t('plugins.secretNotKept')} ${error}`)
  }

  /** `plugin-secret-result`: main's or the daemon's answer to a secret's change. */
  pluginSecretResult(callId: number, error: string | null): void {
    const resolve = this.pluginSecretCalls.get(callId)
    if (!resolve) return
    this.pluginSecretCalls.delete(callId)
    resolve(error)
  }

  /** Tells a plugin whose script is loaded that one of its settings changed; a secret only by key. */
  private pluginSettingEvent(pluginId: string, key: string, secret: boolean): void {
    if (this.pluginHost.status().find((plugin) => plugin.id === pluginId)?.state !== 'active') {
      return
    }
    const value = secret ? null : this.plugins.settingValue(pluginId, key)
    this.pluginHost
      .deliverEvent(pluginId, 'settings.changed', { key, secret, value })
      .catch((error: unknown) =>
        writeLog(
          'warn',
          'plugins',
          `Could not tell ${pluginId} of ${key}: ${(error as Error).message}`,
        ),
      )
  }

  /** The computer slept or woke, so the routines' timer starts over from the wall clock. */
  power(state: 'suspend' | 'resume'): void {
    this.routines.power(state)
  }

  busy(requestId: number): void {
    this.options.send({ type: 'host:busy', requestId, sessions: this.sessions.busy() })
  }

  /** The floating label's buttons and the stop shortcut, from main. */
  computerControl(sessionId: string, action: ComputerControlAction): void {
    this.computer?.control(sessionId, action)
  }

  /** `host:computer-frame-request`: where the window the holding session uses is now. */
  computerFrame(requestId: number): void {
    const answer = (frame: ComputerFrame | null) =>
      this.options.send({ type: 'host:computer-frame', requestId, frame })
    if (!this.computer) return answer(null)
    this.computer.frame().then(answer, (error: unknown) => {
      this.diagnostics.log('info', `Computer use could not find its window: ${String(error)}`)
      answer(null)
    })
  }

  /**
   * `host:report-request`: a problem report's bundle, written into the data folder's `reports`,
   * which the parent removes once the user saved or dropped it.
   */
  async report(message: Extract<MainToHost, { type: 'host:report-request' }>): Promise<void> {
    let result: ReportBuildResult
    try {
      const request = parseReportRequest(message.request)
      await flushLog()
      result = await writeReport(
        {
          request,
          now: Date.now(),
          parent:
            typeof message.parent === 'object' && message.parent !== null ? message.parent : {},
          settings: message.settings ?? null,
          host: await this.collectDiagnostics(),
          logDir: logFolder(),
          crashDir: typeof message.crashDir === 'string' ? message.crashDir : null,
          screenshot:
            typeof message.screenshot === 'string'
              ? new Uint8Array(Buffer.from(message.screenshot, 'base64'))
              : null,
          redact: redactLogText,
        },
        path.join(this.options.userDataPath, 'reports'),
      )
    } catch (error) {
      result = { ok: false, reason: 'failed', message: (error as Error).message }
    }
    if (!result.ok) this.diagnostics.log('warn', `No problem report: ${result.message}`)
    this.options.send({ type: 'host:report', requestId: message.requestId, result })
  }

  /** Allow once from a request's notification; a request already answered elsewhere is left. */
  answerPermission(sessionId: string, requestId: string, optionId: string): void {
    try {
      this.sessions.respond(sessionId, requestId, { optionId })
    } catch (error) {
      this.diagnostics.log(
        'info',
        `A notification's answer was not taken: ${(error as Error).message}`,
      )
    }
  }

  /** Takes the paths main granted for attachments, then says so, before main answers the renderer. */
  grant(requestId: number, grants: AttachmentGrant[]): void {
    this.attachments.grant(grants)
    this.options.send({ type: 'host:granted', requestId })
  }

  /** `host:artifact-content-request`: the files of a version, for main's protocol. */
  async artifactContent(requestId: number, id: string, version: number | null): Promise<void> {
    let result: ArtifactContentResult
    try {
      result = { kind: 'found', ...(await this.artifacts.content(id, version ?? undefined)) }
    } catch (error) {
      if (error instanceof ArtifactError) {
        result = { kind: 'not_found' }
      } else {
        this.diagnostics.log('warn', `Could not find ${id}'s content: ${(error as Error).message}`)
        result = { kind: 'failed' }
      }
    }
    this.options.send({ type: 'host:artifact-content', requestId, result })
  }

  /** `host:artifact-runtime`: a page's message main relayed from an artifact origin it serves. */
  artifactRuntime(requestId: number, artifactId: string, message: unknown): void {
    this.runtimeRequests.fromMain(requestId, artifactId, message, (answer: RuntimeAnswer) =>
      this.options.send({ type: 'host:artifact-runtime-answer', requestId, answer }),
    )
  }

  /** `host:artifact-runtime-cancel`: the page closed its request, which ends a stream. */
  artifactRuntimeCancel(requestId: number): void {
    this.runtimeRequests.cancelMain(requestId)
  }

  /** The artifact's folder as a project, or null for a scratch folder, which is No project. */
  private projectOf(folder: string): string | null {
    return this.scratch.contains(folder) ? null : folder
  }

  /**
   * The artifact as the runtime checks a page's request against it: what its latest version
   * declares, and for one made from a type, what its type's viewer uses.
   */
  private async declaredArtifact(id: string): Promise<DeclaredArtifact | null> {
    const [declared, found] = await Promise.all([
      this.artifacts.runtime('declaration', { id, project: null, version: null }),
      this.artifacts.get(id),
    ]).catch(() => [null, null] as const)
    if (!declared || !found?.type) return declared
    const implied = this.artifactTypes.capabilities(found.type.name)
    return { ...declared, capabilities: [...new Set([...declared.capabilities, ...implied])] }
  }

  /**
   * The agent that answers the questions of a page of `project`, null for No project: the agent
   * new sessions start with, else the one its latest session used, when that agent can answer
   * without tools.
   */
  private async sampleAgent(project: string | null): Promise<SampleAgent | null> {
    const agentId = this.preferredAgent(project)
    if (agentId === null || !QUESTION_HARNESSES.has(harnessOf(agentId))) return null
    return { id: agentId, name: this.agents.name(agentId) }
  }

  /**
   * The agent Kettu asks on its own account about `project`, null for No project: the agent new
   * sessions start with, else the one its latest session used; null when it is gone or off.
   */
  private preferredAgent(project: string | null): AgentId | null {
    let agentId = this.settings.defaultAgent
    if (agentId === null) {
      const sessions = project === null ? this.sessions.list() : this.sessions.list(project)
      agentId = sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.agentId ?? null
    }
    if (agentId === null || !this.agents.has(agentId) || this.agents.isDisabled(agentId))
      return null
    return agentId
  }

  /**
   * A commit message for the changed files at `paths`, from the project's preferred agent or the
   * one the lightweight tasks' model is pinned to.
   */
  private async commitMessage(projectPath: string, paths: string[]): Promise<string> {
    const context = await this.gitProjectCall(projectPath, (g, p) => g.commitContext(p, paths))
    const target = lightTarget(this.settings.lightModel, this.preferredAgent(projectPath), null)
    if (target === null) throw new HostError('agent_error', t('git.commitMessageNoAgent'))
    const agent = this.agents.name(target.agentId)
    try {
      const runtime = await this.agents.ensureReady(target.agentId)
      const dir = path.join(this.options.userDataPath, 'agent-reports')
      await mkdir(dir, { recursive: true })
      return await writeCommitMessage(runtime, {
        dir,
        context,
        model: target.model,
        log: (line) => this.diagnostics.log('warn', line),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.diagnostics.log('warn', `${agent}: could not write a commit message: ${logText(error)}`)
      throw new HostError('agent_error', t('git.commitMessageFailed', { agent, reason }))
    }
  }

  /**
   * A title and description for a pull request of the branch into `base`, from the project's
   * preferred agent or the one the lightweight tasks' model is pinned to.
   */
  private async pullRequestDraft(
    projectPath: string,
    base: string,
  ): Promise<{ title: string; body: string }> {
    const context = await this.gitProjectCall(projectPath, (g, p) => g.pullRequestContext(p, base))
    const target = lightTarget(this.settings.lightModel, this.preferredAgent(projectPath), null)
    if (target === null) throw new HostError('agent_error', t('git.draftNoAgent'))
    const agent = this.agents.name(target.agentId)
    try {
      const runtime = await this.agents.ensureReady(target.agentId)
      const dir = path.join(this.options.userDataPath, 'agent-reports')
      await mkdir(dir, { recursive: true })
      return await writePullRequestDraft(runtime, {
        dir,
        context,
        model: target.model,
        log: (line) => this.diagnostics.log('warn', line),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.diagnostics.log('warn', `${agent}: could not write a pull request: ${logText(error)}`)
      throw new HostError('agent_error', t('git.draftFailed', { agent, reason }))
    }
  }

  /**
   * A draft of a problem report's description from the agent the report is about, else the one
   * new sessions start with, unless the lightweight tasks' model is pinned to another; null when
   * Kettu observed nothing to write from.
   */
  private async draftReport(
    params: HostParams<'agents.draftReport'>,
  ): Promise<{ draft: string | null; agent: string | null }> {
    const session =
      params.sessionId !== null && this.sessions.has(params.sessionId)
        ? this.sessions.summary(params.sessionId)
        : null
    const about = session?.agentId ?? params.agentId
    const known = about !== null && this.agents.has(about)
    const prompt = reportDraftPrompt(
      {
        origin: params.origin,
        language: params.language,
        agent: known ? this.agents.name(about) : null,
        error: params.error,
        log: this.diagnostics.logEntries(),
        events: known ? this.diagnostics.agentEvents(about) : [],
        now: Date.now(),
      },
      redactLogText,
    )
    if (prompt === null) return { draft: null, agent: null }
    const agentId =
      known && !this.agents.isDisabled(about)
        ? about
        : this.preferredAgent(session && !session.scratch ? session.projectPath : null)
    // The session's model only for its own agent, which another agent may not offer.
    const model = session && session.agentId === agentId ? session.model : null
    const target = lightTarget(this.settings.lightModel, agentId, model)
    if (target === null) throw new HostError('agent_error', t('report.draftNoAgent'))
    const agent = this.agents.name(target.agentId)
    try {
      const runtime = await this.agents.ensureReady(target.agentId)
      const dir = path.join(this.options.userDataPath, 'agent-reports')
      await mkdir(dir, { recursive: true })
      const draft = await writeReportDraft(runtime, {
        dir,
        prompt,
        model: target.model,
        log: (line) => this.diagnostics.log('warn', line),
      })
      return { draft, agent }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // Info: the report this draft is for must not read its own failure as part of the problem.
      this.diagnostics.log('info', `${agent}: could not draft a problem report: ${logText(error)}`)
      throw new HostError('agent_error', t('report.draftFailed', { agent, reason }))
    }
  }

  /** A page's question to the agent, in a hidden session with no tools in the reports' folder. */
  private async answerQuestion(agent: SampleAgent, question: SampleQuestion): Promise<string> {
    const runtime = await this.agents.ensureReady(agent.id as AgentId)
    const { connection } = runtime
    if (!connection.answerQuestion) {
      throw new CapabilityError('unsupported', `${agent.name} cannot answer without tools.`)
    }
    const dir = path.join(this.options.userDataPath, 'agent-reports')
    await mkdir(dir, { recursive: true })
    return connection.answerQuestion(dir, question.prompt, question.onText, question.signal)
  }

  /** `host:artifact-list-request`: every artifact, for main to publish them and unpublish the gone. */
  async artifactList(requestId: number): Promise<void> {
    let result: ArtifactListResult
    try {
      const [kept, deleted] = await Promise.all([
        this.artifacts.list({ deleted: false }),
        this.artifacts.list({ deleted: true }),
      ])
      result = {
        kind: 'listed',
        artifacts: [...kept.map((a) => brief(a, false)), ...deleted.map((a) => brief(a, true))],
      }
    } catch (error) {
      this.diagnostics.log('warn', `Could not list the artifacts: ${(error as Error).message}`)
      result = { kind: 'failed' }
    }
    this.options.send({ type: 'host:artifact-list', requestId, result })
  }

  /** `host:artifact-export-request`: a typed version converted for main to save. */
  async artifactExport(
    requestId: number,
    id: string,
    version: number,
    format: ArtifactExportFormat,
  ): Promise<void> {
    let result: ArtifactExportResult
    try {
      const found = await this.artifacts.get(id, { version })
      const files = await exportVersion(this.artifacts, found, format)
      result = { kind: 'exported', title: found.artifact.title, files }
    } catch (error) {
      if (error instanceof ArtifactError && error.reason === 'not_found') {
        result = { kind: 'not_found' }
      } else {
        const message = (error as Error).message
        this.diagnostics.log('warn', `Could not export ${id} as ${format}: ${message}`)
        result = { kind: 'failed', message }
      }
    }
    this.options.send({ type: 'host:artifact-export', requestId, result })
  }

  /**
   * `host:artifact-import-request`: makes an artifact of a file or folder the user chose, in
   * `project` or, when it is null, in a new scratch folder, which the page lists under No project.
   */
  async artifactImport(requestId: number, file: string, project: string | null): Promise<void> {
    let result: NonNullable<ArtifactImportResult>
    try {
      let folder: string | null = null
      if (project !== null) {
        folder = await this.projects.resolveDirectory(project)
        if (!this.scratch.contains(folder)) this.projects.match(folder)
      }
      const read = await readImport(file)
      if ('failed' in read) {
        result = read
      } else {
        // Made only now, so a file that cannot be read leaves no empty folder behind.
        folder ??= await this.scratch.create()
        const { id } = await this.artifacts.create({
          project: folder,
          sessionId: NO_SESSION,
          title: read.title,
          files: read.files,
          pages: read.pages,
          note: null,
        })
        result = { id }
      }
    } catch (error) {
      this.diagnostics.log('warn', `Could not import an artifact: ${(error as Error).message}`)
      result = { failed: 'unavailable' }
    }
    this.options.send({ type: 'host:artifact-import', requestId, result })
  }

  /**
   * Sends a browser call to the desktop app that sent the session's turn, or to main, and settles
   * with its answer, or a failure if the host stops. The caller's turn uses the page from now until
   * it ends; a step the agent asks the user for shows in the page's session's thread meanwhile.
   */
  async browserCall(
    request: BrowserCallRequest,
    caller = request.sessionId,
  ): Promise<BrowserCallAnswer> {
    const page = request.sessionId
    const target = browserTarget(this.sessions.browserSender(page), this.hub)
    if (target.kind === 'gone') {
      return { error: { code: 'unavailable', message: BROWSER_GONE } }
    }
    const left = this.browserTurns.used(caller, page, target)
    if (left) this.tellTurnEnded(page, left)
    const asking = request.tool === 'browser_ask_user'
    if (asking) {
      const { step, reason } = request.args
      this.sessions.controlAsked(page, {
        surface: 'browser',
        step: isControlStep(step) ? step : 'other',
        target: this.browserSites.get(page) ?? null,
        reason: typeof reason === 'string' ? reason : '',
      })
    }
    const answer =
      target.kind === 'device'
        ? await this.deviceBrowser.call(target.portId, request)
        : await this.mainBrowserCall(request)
    if ('result' in answer) {
      const site = siteOf(answer.result.value.url)
      if (site) this.browserSites.set(page, site)
    }
    if (asking) {
      if ('result' in answer) {
        const outcome = answer.result.value.outcome
        this.sessions.controlAskSettled(page, isControlOutcome(outcome) ? outcome : 'ended')
      } else if (answer.error.code !== 'user_has_control') {
        // Only a wait that goes on keeps the card; anything else ended the step.
        this.sessions.controlAskSettled(page, 'ended')
      }
    }
    return answer
  }

  /** Sends a browser call to main, which drives the page of the host's own windows. */
  private mainBrowserCall(request: BrowserCallRequest): Promise<BrowserCallAnswer> {
    // The tools' id travels to main unchanged, so its report of a site wait names the same call.
    const callId = request.callId
    return new Promise<BrowserCallAnswer>((resolve) => {
      this.browserCalls.set(callId, resolve)
      this.options.send({
        type: 'host:browser-call',
        callId,
        sessionId: request.sessionId,
        tool: request.tool,
        args: request.args,
        projectPath: request.projectPath,
        ...(request.allowTab ? { allowTab: request.allowTab } : {}),
      })
    })
  }

  /** A session's turn ended: the pages no running turn uses now are nobody's. */
  private browserTurnEnded(sessionId: string): void {
    for (const { page, target } of this.browserTurns.turnEnded(sessionId)) {
      this.tellTurnEnded(page, target)
    }
  }

  private tellTurnEnded(page: string, target: Exclude<BrowserTarget, { kind: 'gone' }>): void {
    if (target.kind === 'main')
      this.options.send({ type: 'host:browser-turn-ended', sessionId: page })
    else this.hub.send([target.portId], { type: 'browser.turnEnded', sessionId: page })
  }

  /** `host:browser-handed-back`: the user handed main's page back; the thread says for how long. */
  browserHandedBack(sessionId: string, durationMs: number): void {
    this.sessions.controlHandedBack(sessionId, 'browser', durationMs)
  }

  /**
   * `host:browser-waiting`: the call waits on a new origin, so its own time limit grows to that
   * wait and the call fails `not_allowed` rather than timing out first.
   */
  browserWaiting(callId: number, waiting: boolean): void {
    this.artifactService.browserWaiting(callId, waiting)
  }

  /** `host:browser-origin-ask`: main's page waits for a new origin, which the thread shows. */
  browserOriginAsked(requestId: number, sessionId: string, origin: string): void {
    this.sessions.browserOriginAsked(sessionId, requestId, origin)
  }

  /** `host:browser-origin-answer`: the wait ended, so the session's card takes the answer. */
  browserOriginSettled(requestId: number, decision: BrowserOriginAnswer): void {
    this.sessions.browserOriginSettled(requestId, decision)
  }

  /** Sends an agent's device call to its parent, which hands it to the device host. */
  deviceCall(call: DeviceCall): Promise<DeviceCallAnswer> {
    if (call.kind === 'action') this.deviceTurns.add(call.sessionId)
    const callId = this.nextDeviceCall++
    return new Promise<DeviceCallAnswer>((resolve) => {
      this.deviceCalls.set(callId, resolve)
      this.options.send({ type: 'host:device-call', callId, call })
    })
  }

  /** `host:device-handed-back`: the user handed a device back; the thread says for how long. */
  deviceHandedBack(sessionId: string, durationMs: number): void {
    this.sessions.controlHandedBack(sessionId, 'device', durationMs)
  }

  /**
   * The user's Run on a shell code block of a session's reply: a new terminal of the session's
   * agent runs it, the way the agent's own terminal tool does, and unless `notify` is false the
   * session is told which, queued while a turn runs. A subagent's reply runs for the session it
   * runs under, which has the terminals and takes prompts.
   */
  private async runReplyCommand(
    params: { sessionId: string; command: string; notify: boolean },
    portId: string,
    device: PortDevice | null,
  ): Promise<{ terminalId: string; notified: boolean }> {
    const sessionId = this.sessions.browserSession(params.sessionId)
    const agentId = sessionId ? this.sessions.sessionAgent(sessionId) : null
    if (!sessionId || !agentId) throw new HostError('not_found', t('session.notFound'))
    const folder = this.sessions.sessionFolder(sessionId) ?? this.sessions.sessionProject(sessionId)
    if (!folder) throw new HostError('restricted', t('hostError.noFolder'))
    const answer = await this.terminalCall({
      kind: 'reply',
      sessionId,
      agentId,
      folder,
      command: params.command,
      fromDevice: device !== null,
    })
    if ('error' in answer) {
      throw new HostError(REPLY_RUN_ERRORS[answer.error.code], answer.error.message)
    }
    if (answer.result.kind !== 'terminal') throw new HostError('internal', 'No terminal opened')
    const terminalId = answer.result.terminal.id
    if (!params.notify) return { terminalId, notified: false }
    try {
      const text = replyRunNotice(terminalId, params.command)
      await this.sessions.queue(sessionId, [{ type: 'text', text }], portId, fromDevice(device))
      return { terminalId, notified: true }
    } catch (error) {
      writeLog('warn', 'host', `A reply's run could not be told: ${(error as Error).message}`)
      return { terminalId, notified: false }
    }
  }

  /**
   * The terminals, browser tabs and devices a user's message references: the session's agent may
   * use them from now on, as the user shared them. A terminal of a session that exists gets the
   * allow at once, so its tab says so; the rest is given on the agent's first call, as New
   * session's terminals reach their session only later.
   */
  private shareSurfaces(sessionId: string | null, content: readonly UserContent[]): void {
    for (const item of content) {
      if (item.type !== 'ref') continue
      if (item.ref.kind === 'page') this.sharedTabs.set(item.ref.tabId, sessionId)
      if (item.ref.kind === 'device') this.sharedDevices.set(item.ref.deviceId, sessionId)
      if (item.ref.kind !== 'terminal') continue
      const terminalId = item.ref.terminalId
      this.sharedTerminals.set(terminalId, sessionId)
      if (sessionId === null) continue
      const session = this.sessions.browserSession(sessionId) ?? sessionId
      void this.terminalCall({ kind: 'allow', sessionId: session, terminalId, allowed: true })
    }
  }

  /** Takes back the session's agent the use of a terminal the user opened, from the tab's menu. */
  private async revokeTerminal(sessionId: string, terminalId: string): Promise<void> {
    this.sharedTerminals.delete(terminalId)
    const answer = await this.terminalCall({ kind: 'allow', sessionId, terminalId, allowed: false })
    if ('error' in answer) throw new HostError('not_found', answer.error.message)
    this.sessions.surfaceAccessRevoked(sessionId, terminalId)
  }

  /** Sends an agent's terminal call to its parent, which hands it to the terminal host. */
  terminalCall(call: TerminalCall): Promise<TerminalCallAnswer> {
    // Only these take the terminal for the turn; the terminal host frees it when the turn ends.
    if (call.kind === 'run' || call.kind === 'input' || call.kind === 'stop') {
      this.terminalTurns.add(call.sessionId)
    }
    const callId = this.nextTerminalCall++
    return new Promise<TerminalCallAnswer>((resolve) => {
      this.terminalCalls.set(callId, resolve)
      this.options.send({ type: 'host:terminal-call', callId, call })
    })
  }

  /** `terminal-result`: the terminal host's answer to a call this host forwarded. */
  terminalResult(callId: number, answer: TerminalCallAnswer): void {
    const resolve = this.terminalCalls.get(callId)
    if (!resolve) return
    this.terminalCalls.delete(callId)
    resolve(answer)
  }

  /** `host:terminal-handed-back`: the user handed a terminal back; the thread says for how long. */
  terminalHandedBack(sessionId: string, durationMs: number): void {
    this.sessions.controlHandedBack(sessionId, 'terminal', durationMs)
  }

  /** `host:plugin-port`: the plugin host is ready and this is its port. */
  connectPluginHost(port: PortChannel<AgentToPluginHost>): void {
    this.pluginHost.attach(port)
  }

  /** `device-result`: the device host's answer to a call this host forwarded. */
  deviceResult(callId: number, answer: DeviceCallAnswer): void {
    const resolve = this.deviceCalls.get(callId)
    if (!resolve) return
    this.deviceCalls.delete(callId)
    resolve(answer)
  }

  /** `browser-result`: the answer to a call this host forwarded. */
  browserResult(callId: number, result: unknown, problem: unknown): void {
    const resolve = this.browserCalls.get(callId)
    if (!resolve) return
    this.browserCalls.delete(callId)
    resolve(answerOf(result, problem))
  }

  /** Main is gone: every call awaiting it fails with `timeout`, as its own limit would. */
  private failBrowserCalls(): void {
    for (const resolve of this.browserCalls.values()) {
      resolve({
        error: { code: 'timeout', message: 'Main stopped before the browser answered.' },
      })
    }
    this.browserCalls.clear()
    for (const resolve of this.deviceCalls.values()) {
      resolve({
        error: { code: 'unavailable', message: 'Kettu stopped before the device answered.' },
      })
    }
    this.deviceCalls.clear()
    for (const resolve of this.terminalCalls.values()) {
      resolve({
        error: { code: 'unavailable', message: 'Kettu stopped before the terminal answered.' },
      })
    }
    this.terminalCalls.clear()
    for (const resolve of this.marketCalls.values()) {
      resolve({
        error: { code: 'network', status: null, message: 'Kettu stopped before it answered.' },
      })
    }
    this.marketCalls.clear()
    for (const resolve of this.trashCalls.values()) resolve('Kettu stopped before it answered.')
    this.trashCalls.clear()
    for (const resolve of this.pluginSecretCalls.values())
      resolve('Kettu stopped before it answered.')
    this.pluginSecretCalls.clear()
  }

  /** Stops every agent with the documented sequence, flushes the state files, then reports. */
  shutdown(): Promise<void> {
    this.stopping ??= (async () => {
      await this.routines.shutdown()
      this.sessions.shutdown()
      this.idleRelease.stop()
      this.plugins.stop()
      this.pluginHost.stop()
      this.load.stop()
      this.usage.stop()
      this.artifacts.stop()
      this.execRunner.killAll()
      for (const unsubscribe of this.gitUnsubscribe) unsubscribe()
      await Promise.all([
        this.agents.stopAll(),
        this.git?.dispose().catch((error: unknown) => {
          this.diagnostics.log(
            'warn',
            `Git service did not stop cleanly: ${(error as Error).message}`,
          )
        }),
      ])
      await Promise.all([
        this.artifactService.stop(),
        this.computer?.shutdown(),
        this.projects.flush(),
        this.sessions.flush(),
        this.remembered.flush(),
        this.updates.flush(),
        this.registryListing.flush(),
        this.harnessManifest.flush(),
        this.star.flush(),
        this.trees.close(),
        this.agentOptions.flush(),
        this.preparedRecords.flush(),
        this.attachments.flush(),
        this.marketCatalog.flush(),
        this.marketSkills.flush(),
        this.marketBundles.flush(),
        this.plugins.flush(),
        this.publishDrafts.flush(),
        this.workflowSuggestions.flush(),
        this.threads?.close(),
        this.usage.close(),
      ])
      this.hub.closeAll()
      this.failBrowserCalls()
      this.options.send({ type: 'host:stopped' })
    })()
    return this.stopping
  }

  async collectDiagnostics(): Promise<DiagnosticsBundle> {
    const node = this.env.nodeProbe()
    const adapters = await Promise.all(
      this.agents.ids().map((agentId) => this.agents.adapterFiles(agentId).catch(() => null)),
    )
    return {
      createdAt: Date.now(),
      appVersion: this.options.appVersion,
      platform: this.options.platform,
      environment: {
        PATH: this.env.get('PATH') ?? null,
        SHELL: this.env.get('SHELL') ?? null,
        node: node.nodeVersion,
      },
      environmentInfo: this.env.info(),
      agents: this.agents.ids().map((agentId, i) => ({
        status: this.agents.status(agentId),
        capabilities: this.agents.rawCapabilities(agentId),
        ...this.diagnostics.agentRecords(agentId),
        adapter: adapters[i] ?? null,
      })),
      sessions: this.sessions.list(),
      log: this.diagnostics.logEntries(),
    }
  }

  private requireGit(): GitServiceApi {
    if (!this.git) throw new HostError('git_error', t('git.notReady'))
    return this.git
  }

  /** Runs git with the resolved environment, so git and gh are found as the agents find them. */
  private async gitCall<T>(run: (git: GitServiceApi) => Promise<T>): Promise<T> {
    const git = this.requireGit()
    await this.env.ready()
    try {
      return await run(git)
    } catch (error) {
      if (error instanceof HostError) throw error
      throw new HostError('git_error', (error as Error)?.message ?? String(error))
    }
  }

  /** Runs a git request that reads or writes a registered project or a scratch folder. */
  private async gitProjectCall<T>(
    projectPath: string,
    run: (git: GitServiceApi, canonical: string) => Promise<T>,
  ): Promise<T> {
    const canonical = await this.gitProject(projectPath)
    return this.gitCall((g) => run(g, canonical))
  }

  /**
   * Refuses a canonical folder that is not a registered project, a scratch folder or a worktree a
   * session works in: files, git and media are read nowhere else.
   */
  private assertOpenFolder(canonical: string): void {
    if (this.scratch.contains(canonical) || this.sessions.isSessionWorktree(canonical)) return
    this.projects.match(canonical)
  }

  /** A registered project, a scratch folder or a session's worktree, canonical; git runs nowhere else. */
  private async gitProject(projectPath: string): Promise<string> {
    this.requireGit()
    const canonical = await this.projects.resolveDirectory(projectPath)
    this.assertOpenFolder(canonical)
    return canonical
  }

  /**
   * Runs a file request for a registered project or a scratch folder, once the environment git
   * needs is resolved.
   */
  private async filesCall<T>(projectPath: string, run: (root: string) => Promise<T>): Promise<T> {
    const canonical = await this.projects.resolveDirectory(projectPath)
    this.assertOpenFolder(canonical)
    await this.env.ready()
    return run(canonical)
  }

  /** For Settings › MCP servers: Kettu's own server and where each agent keeps its own. */
  private async mcpStatus(): Promise<McpStatus> {
    const service = this.artifactService
    return {
      servers: [
        {
          name: SERVICE_NAME,
          title: 'Kettu',
          builtIn: true,
          running: service.listeningPort !== null,
          error: service.error,
          tools: service.toolSummaries(),
        },
      ],
      places: await this.agents.mcpPlaces(),
    }
  }

  private handlers(): Handlers {
    const { agents, sessions, projects, artifacts, routines, memory } = this
    return {
      'agents.list': () => agents.list(),
      'agents.check': ({ agentId }) => agents.check(agentId),
      'agents.reloadEnvironment': async () => {
        const result = await agents.reloadEnvironment()
        // A tool installed since the last probe shows up without a restart.
        if (this.git) await this.gitCall((g) => g.reloadTools())
        return result
      },
      'agents.detectedPrograms': async () => {
        await agents.check()
        return agents.userPrograms()
      },
      'agents.environment': () => this.env.info(),
      'agents.authenticate': ({ agentId, methodId }, ctx) =>
        agents.authenticate(agentId, methodId, {
          device: ctx.device !== null,
          openLink: (url) =>
            this.hub.send([ctx.portId], { type: 'agents.signInLink', agentId, url }),
        }),
      'agents.cancelSignIn': ({ agentId }) => agents.cancelSignIn(agentId),
      'agents.logout': ({ agentId }) => agents.logout(agentId),
      'agents.providerAction': (input) => agents.providerAction(input),
      'agents.retry': ({ agentId }) => agents.retry(agentId),
      'agents.reinstall': ({ agentId }) => agents.reinstall(agentId),
      'agents.checkUpdates': () => agents.checkUpdates(),
      'agents.skipUpdate': ({ agentId }) => agents.skipUpdate(agentId),
      'agents.unskipUpdate': ({ agentId }) => agents.unskipUpdate(agentId),
      'agents.update': ({ agentId }) => agents.update(agentId),
      'agents.updateCli': ({ agentId }) => agents.updateCli(agentId),
      'agents.setApiKey': ({ agentId, ...input }) => agents.setApiKey(agentId, input),
      'agents.clearApiKey': ({ agentId }) => agents.clearApiKey(agentId),
      'agents.install': ({ agentId, method }) => agents.install(agentId, method),
      'agents.uninstall': ({ agentId, removeProgram }) =>
        agents.uninstall(agentId, removeProgram === true),
      'agents.installOffer': ({ agentId }) => agents.installOffer(agentId),
      'agents.cancelTask': ({ agentId }) => agents.cancelTask(agentId),
      'agents.readOptions': async ({ agentId, projectPath }) => {
        const entry = this.agentOptions.get(agentId)
        // A provisional entry lacks the agent's defaults and its mode, which a switch to it shows.
        if (entry && !entry.provisional && Date.now() - entry.observedAt < OPTIONS_FRESH_MS) return
        const folder =
          projectPath === null
            ? null
            : await projects.resolveDirectory(projectPath).catch(() => null)
        await agents.readOptions(agentId, folder ?? undefined)
      },
      'agents.readFirstOptions': async ({ agentId }) => {
        if (this.agentOptions.known(agentId)) return
        await agents.readFirstOptions(agentId)
      },
      'agents.refreshLimits': ({ agentId, force }) => agents.refreshLimits(agentId, { force }),
      'agents.spendReset': ({ agentId, creditId, requestId }) =>
        agents.spendReset(agentId, creditId, requestId),
      'agents.details': ({ agentId }) => agents.details(agentId),
      'agents.claudeSettings': ({ agentId }) =>
        agents.claudeSettings(agentId, listedModels(this.agentOptions.get(agentId)?.config)),
      'agents.setClaudeSetting': ({ agentId, change }) => agents.setClaudeSetting(agentId, change),
      'agents.autoCompact': ({ agentId }) =>
        agents.autoCompact(agentId, this.agentOptions.get(agentId)?.config, () =>
          this.appServer(agentId),
        ),
      'agents.setAutoCompact': ({ agentId, change }) =>
        agents.setAutoCompact(agentId, change, () => this.appServer(agentId)),
      'agents.codebuddySettings': ({ agentId }) => agents.codebuddySettings(agentId),
      'agents.setCodebuddySite': ({ agentId, change }) => agents.setCodebuddySite(agentId, change),
      'agents.refreshAccount': ({ agentId, force }) => agents.refreshAccount(agentId, { force }),
      'agents.options': () => this.agentOptions.list().map((o) => this.withStartMode(o)),
      'agents.pinModel': ({ agentId, model, pinned }) =>
        this.agentOptions.pin(agentId, model, pinned),
      'agents.lightAgents': () => ({ agents: this.sessions.lightAgents() }),
      'agents.draftReport': (params) => this.draftReport(params),
      'mcp.status': () => this.mcpStatus(),
      'market.catalog': ({ refresh, cached }) =>
        this.marketCatalog.catalog(refresh === true, cached === true),
      'market.search': ({ query }) => this.marketCatalog.search(query),
      'market.keys': () => keyState(this.settings.marketplace.mcp, this.marketKeys),
      'market.connect': ({ serverId }) => this.marketConnections.connect(serverId),
      'market.detectSignIn': async ({ url, headers }) => ({
        oauth: await this.marketConnections.detect(
          url,
          Object.fromEntries(headers.map((header) => [header.name, header.value])),
        ),
      }),
      'market.cancelConnect': ({ loginId }) => this.marketConnections.cancel(loginId),
      'market.disconnect': ({ serverId }) => this.marketConnections.disconnect(serverId),
      'market.connections': () => this.marketConnections.view(),
      'market.ownPlugins': ({ refresh }) => this.ownPlugins.plugins(refresh === true),
      'market.skills': ({ refresh, cached }) =>
        this.marketSkills.skills(refresh === true, cached === true),
      'market.skillRepository': ({ id, refresh }) =>
        this.marketSkills.repository(id, refresh === true),
      'market.addSkill': ({ source }) => this.marketSkills.add(source),
      'settings.answerChange': ({ sessionId, entryId, decision }, { device }) =>
        this.sessions.answerSettings(sessionId, entryId, decision, fromDevice(device)),
      'settings.undoChange': ({ sessionId, entryId }) => this.undoSettings(sessionId, entryId),
      'market.answerPublish': ({ sessionId, entryId, ...answer }, { device }) =>
        this.sessions.answerMarket(
          sessionId,
          entryId,
          answer,
          (handle) => this.setPublisher(handle),
          fromDevice(device),
        ),
      'market.publishDrafts': async () => {
        await this.publishDrafts.ready
        return { drafts: this.publishDrafts.list() }
      },
      'market.discardPublishDraft': async ({ id }) => {
        await this.publishDrafts.remove(id)
        this.hub.broadcast({ type: 'market.publishedChanged' })
      },
      'market.account': () => ({ account: this.marketAccount }),
      'market.published': async () => {
        await this.publishDrafts.ready
        return this.marketTools.published()
      },
      'market.setPublisher': ({ handle }) => this.marketTools.renamePublisher(handle),
      'market.updateListing': ({ id, change }) => this.marketTools.updateListing(id, change),
      'market.withdrawVersion': ({ id, version }) => this.marketTools.withdrawVersion(id, version),
      'market.deleteListing': ({ id }) => this.marketTools.deleteListing(id),
      'market.versionFiles': ({ id, version }) => this.marketTools.versionFiles(id, version),
      'market.checkFolder': async ({ path: folder, draftId }) => {
        await this.publishDrafts.ready
        return this.marketTools.checkFolder(folder, draftId ?? null)
      },
      'market.convertFolder': ({ path: folder }) => this.pluginConverter.folder(folder),
      'market.convertListing': ({ id }) => this.pluginConverter.listing(id),
      'market.publishFolder': async ({ path: folder, draftId, visibility, notes, handle }) => {
        await this.publishDrafts.ready
        // A first publish sets the publisher name before anything is uploaded, as the card does.
        if (handle !== undefined) await this.setPublisher(handle)
        return this.marketTools.publishFolder(folder, {
          draftId: draftId ?? null,
          visibility: visibility ?? null,
          notes: notes ?? null,
        })
      },
      'market.community': ({ refresh, ...query }) =>
        this.marketCommunity.directory(query, refresh === true),
      'market.communityListing': ({ id }) => this.marketCommunity.listing(id),
      'market.communityWorkflow': ({ id }) => this.marketCommunity.workflow(id),
      'market.communityInstalled': ({ refresh }) =>
        this.marketCommunity.installed(refresh === true),
      'market.addCommunityWorkflow': ({ id }) => this.marketCommunity.installWorkflow(id),
      'market.reportCommunity': ({ id, message }) => this.marketCommunity.report(id, message),
      'market.bundlePrepare': ({ id }) => this.marketBundles.prepare(id),
      'market.bundleCommit': ({ token, values }) => this.marketBundles.commit(token, values),
      'market.bundleCancel': ({ token }) => this.marketBundles.cancel(token),
      'mcp.retry': async () => {
        await this.artifactService.start()
        this.options.send({ type: 'host:service-port', port: this.artifactService.listeningPort })
        return this.mcpStatus()
      },
      'agents.listSessions': ({ agentId, projectPath, cursor }) =>
        sessions.listImportable(agentId, projectPath, cursor ?? null),
      'projects.list': () => {
        void projects.refreshMissing()
        return projects.list()
      },
      'projects.add': ({ path }) => projects.add(path),
      'projects.remove': async ({ path }) => {
        const record = projects.match(path)
        await sessions.removeProject(record.path)
        projects.remove(record)
        this.options.send({ type: 'host:media-revoke', sessionId: null })
      },
      'projects.touch': ({ path }) => projects.touch(projects.match(path)),
      'projects.pin': ({ path, pinned }) =>
        path === null ? projects.pinNoProject(pinned) : projects.pin(projects.match(path), pinned),
      'projects.move': ({ path, before }) =>
        projects.move(projects.match(path), before === null ? null : projects.match(before)),
      'projects.noProject': () => projects.noProject(),
      'projects.worktreeSettings': ({ path }) =>
        projects.worktreeSettings(projects.match(path).path),
      'projects.setWorktreeSettings': ({ path, settings }) =>
        projects.setWorktreeSettings(projects.match(path).path, settings),
      'paths.complete': ({ path }) =>
        completePath(path, this.options.platform, this.options.homeDir ?? os.homedir()),
      'sessions.list': ({ projectPath }) => sessions.list(projectPath),
      'sessions.create': async (params, { portId, device }) => {
        // A worktree is made with git, which is found as the agents find it.
        if (params.worktree) await this.env.ready()
        if (params.prompt) this.shareSurfaces(null, params.prompt)
        return sessions.create(device ? { ...params, device: fromDevice(device) } : params, portId)
      },
      'sessions.prepare': (params, { portId }) => sessions.prepare(params, portId),
      'sessions.discard': ({ sessionId }) => sessions.discard(sessionId),
      'sessions.import': (params) => sessions.importSession(params),
      'sessions.open': async ({ sessionId }, { device }) =>
        digestsFor(device, await sessions.open(sessionId, imagesFor(device))),
      'sessions.snapshot': async ({ sessionId, from }, { device }) =>
        digestsFor(device, await sessions.snapshot(sessionId, from, imagesFor(device))),
      'sessions.page': async ({ sessionId, before, from }, { device }) =>
        digestsFor(device, await sessions.page(sessionId, before, from, imagesFor(device))),
      'sessions.entry': ({ sessionId, entryId }, { device }) =>
        sessions.entry(sessionId, entryId, imagesFor(device)),
      'sessions.requests': async ({ sessionId }, { device }) => ({
        ...(await sessions.requests(sessionId, imagesFor(device))),
        suggestions: await this.workflowSuggestions.waitingFor(sessionId),
      }),
      'sessions.outline': ({ sessionId }) => sessions.outline(sessionId),
      'sessions.modelRequests': ({ sessionId, before }) =>
        sessions.modelRequests(sessionId, before ?? null),
      'sessions.modelRequestsOverview': ({ sessionId }) =>
        sessions.modelRequestsOverview(sessionId),
      'sessions.modelRequestRaw': ({ sessionId, raw, full }) =>
        sessions.modelRequestRaw(sessionId, raw, full === true),
      'sessions.search': ({ query }) => sessions.search(query),
      'sessions.find': ({ sessionId, query }) => sessions.find(sessionId, query),
      'sessions.outputs': ({ sessionId }) => sessions.outputs(sessionId),
      'sessions.outlineTitles': ({ sessionId }) => sessions.outlineTitles(sessionId),
      'sessions.watch': ({ sessionId }, { portId }) => sessions.watch(sessionId, portId),
      'sessions.unwatch': ({ sessionId }, { portId }) => sessions.unwatch(sessionId, portId),
      'sessions.show': ({ sessionIds }, { portId }) => sessions.show(sessionIds, portId),
      'sessions.prompt': ({ sessionId, content }, { portId, device }) => {
        this.shareSurfaces(sessionId, content)
        return sessions.prompt(sessionId, content, portId, fromDevice(device))
      },
      'sessions.attachEarly': ({ sessionId }) => sessions.attachEarly(sessionId),
      'sessions.cancel': ({ sessionId }) => sessions.cancel(sessionId),
      'sessions.runningWork': ({ sessionIds }) => ({ sessions: sessions.runningWork(sessionIds) }),
      'sessions.idleRelease': () => this.idleRelease.state(),
      'host.load.watch': (_, { portId }) => this.load.watch(portId),
      'host.load.unwatch': (_, { portId }) => this.load.unwatch(portId),
      'sessions.stopTask': ({ sessionId, taskId }) => sessions.stopTask(sessionId, taskId),
      'sessions.taskOutput': ({ sessionId, taskId }) => sessions.taskOutput(sessionId, taskId),
      'sessions.retry': ({ sessionId }, { portId }) => sessions.retry(sessionId, portId),
      'sessions.cancelContinue': ({ sessionId }) => sessions.cancelContinue(sessionId),
      'sessions.rewind': ({ sessionId, entryId, draft }) =>
        sessions.rewind(sessionId, entryId, draft),
      'sessions.putBack': ({ sessionId }) => sessions.putBack(sessionId),
      'sessions.sideAsk': ({ sessionId, question, quote, agentId }) =>
        sessions.sideAsk(sessionId, question, quote ?? null, agentId ?? null),
      'sessions.sideStop': ({ sessionId }) => sessions.sideStop(sessionId),
      'sessions.sideClear': ({ sessionId, undo }) => sessions.sideClear(sessionId, undo === true),
      'sessions.sideAgents': ({ sessionId }) => ({ agents: sessions.sideAgents(sessionId) }),
      'sessions.fork': ({ sessionId, entryId, worktree }) =>
        sessions.fork(sessionId, entryId, worktree),
      'worktrees.inspect': ({ sessionId }) =>
        this.gitCall(() => sessions.inspectWorktree(sessionId)),
      'worktrees.remove': ({ sessionId, branch, expected }) =>
        this.gitCall(() => sessions.removeWorktree(sessionId, branch, expected)),
      'worktrees.retrySetup': ({ sessionId }) => sessions.retryWorktreeSetup(sessionId),
      'worktrees.skipSetup': ({ sessionId }) => sessions.skipWorktreeSetup(sessionId),
      'worktrees.setupLog': ({ sessionId, from }) => sessions.worktreeSetupLog(sessionId, from),
      'sessions.switchAgent': (params, { portId, device }) => {
        this.shareSurfaces(params.sessionId, params.content)
        return sessions.switchAgent(params, portId, fromDevice(device))
      },
      'sessions.context': ({ sessionId }) => sessions.context(sessionId),
      'sessions.contextEstimates': ({ sessionId }) => sessions.contextEstimates(sessionId),
      'sessions.queue': ({ sessionId, content, comments }, { portId, device }) => {
        this.shareSurfaces(sessionId, content)
        return sessions.queue(sessionId, content, portId, fromDevice(device), comments)
      },
      'sessions.runCommand': (params, { portId, device }) =>
        this.runReplyCommand(params, portId, device),
      'sessions.unqueue': ({ sessionId, itemId }) => sessions.unqueue(sessionId, itemId),
      'sessions.steer': ({ sessionId, itemId }) => sessions.steer(sessionId, itemId),
      'sessions.sendNow': ({ sessionId, itemId }) => sessions.sendNow(sessionId, itemId),
      'sessions.resumeQueue': ({ sessionId }) => sessions.resumeQueue(sessionId),
      'sessions.blob': ({ sessionId, hash }) => sessions.blob(sessionId, hash),
      'sessions.setConfigOption': ({ sessionId, optionId, value }) =>
        sessions.setConfigOption(sessionId, optionId, value),
      'sessions.refreshModels': ({ sessionId }) => sessions.refreshModels(sessionId),
      'sessions.rename': ({ sessionId, title }) => sessions.rename(sessionId, title),
      'sessions.close': ({ sessionId }) => sessions.close(sessionId),
      'sessions.pin': ({ sessionId, pinned }) => sessions.pin(sessionId, pinned),
      'sessions.archive': ({ sessionId, subSessions }) =>
        sessions.archive(sessionId, subSessions ?? true),
      'sessions.unarchive': ({ sessionId }) => sessions.unarchive(sessionId),
      'sessions.markUnread': ({ sessionId, unread }) => sessions.markUnread(sessionId, unread),
      'sessions.delete': async ({ sessionId }) => {
        await sessions.delete(sessionId)
        this.options.send({ type: 'host:media-revoke', sessionId })
      },
      'sessions.removeEmpty': ({ keep }) => sessions.removeEmptyOnce(keep),
      'sessions.takeReturned': ({ sessionId }, { portId }) =>
        sessions.takeReturned(sessionId, portId),
      'routines.list': () => routines.list(),
      'routines.create': (draft) => routines.create(draft),
      'routines.update': ({ routineId, changes }) => routines.update(routineId, changes),
      'routines.delete': ({ routineId }) => routines.delete(routineId),
      'routines.runNow': ({ routineId }) => routines.runNow(routineId),
      'routines.cancelRun': ({ runId }) => routines.cancelRun(runId),
      'routines.runs': ({ routineId, before }) => routines.runsOf(routineId, before),
      'routines.markSeen': ({ routineId }) => routines.markSeen(routineId),
      'plugins.list': async () => ({ plugins: await this.plugins.list() }),
      'plugins.inspect': ({ source }) => this.plugins.inspect(source),
      'plugins.install': ({ token }) => this.plugins.install(token),
      'plugins.discard': ({ token }) => this.plugins.discard(token),
      'plugins.uninstall': ({ pluginId }) => this.plugins.uninstall(pluginId),
      'plugins.setEnabled': ({ pluginId, enabled }) => this.plugins.setEnabled(pluginId, enabled),
      'plugins.setSetting': ({ pluginId, key, value }) =>
        this.plugins.setSetting(pluginId, key, value),
      'plugins.setSecret': ({ pluginId, key, value }) => this.setPluginSecret(pluginId, key, value),
      'plugins.setChannelKinds': ({ pluginId, channel, kinds }) =>
        this.plugins.setChannelKinds(pluginId, channel, kinds),
      'plugins.reload': ({ pluginId }) => this.plugins.reload(pluginId),
      'plugins.checkUpdates': async ({ pluginId }) => ({
        plugins: await this.plugins.checkUpdates(pluginId),
      }),
      'plugins.applyUpdate': ({ pluginId }) => this.plugins.applyUpdate(pluginId),
      'plugins.declineUpdate': ({ pluginId }) => this.plugins.declineUpdate(pluginId),
      'plugins.rollBack': ({ pluginId }) => this.plugins.rollBack(pluginId),
      'plugins.viewData': ({ pluginId, viewId, params }) =>
        this.pluginViews.data(pluginId, viewId, params ?? {}),
      'plugins.viewAction': ({ pluginId, viewId, params, ...input }) =>
        this.pluginViews.act(pluginId, viewId, params ?? {}, input),
      'plugins.actionRun': ({ pluginId, actionId }) => this.pluginViews.run(pluginId, actionId),
      'plugins.refs': () => ({ plugins: this.plugins.refSources() }),
      'plugins.mentionSearch': ({ pluginId, source, query }) =>
        this.pluginRefs.search(pluginId, source, query),
      'plugins.linkCard': ({ pluginId, link, url }) => this.pluginRefs.card(pluginId, link, url),
      'plugins.resources': async ({ kind }) => ({ items: await this.plugins.resources(kind) }),
      'commands.list': async () => ({ commands: await this.commands.list() }),
      'roles.list': async () => ({ roles: await this.roles.list() }),
      'workflows.list': () => this.workflowLibrary.list(),
      'workflows.read': ({ workflowId }) => this.workflowLibrary.read(workflowId),
      'workflows.add': (source) => this.workflowLibrary.add(source),
      'workflows.update': ({ workflowId }) => this.workflowLibrary.update(workflowId),
      'workflows.approve': ({ workflowId, hash }) => this.workflowLibrary.approve(workflowId, hash),
      'workflows.remove': ({ workflowId }) => this.workflowLibrary.remove(workflowId),
      'workflows.suggestions': ({ sessionId }) => this.workflowSuggestions.forSession(sessionId),
      'workflows.suggestionFile': async ({ id }) => ({
        text: await this.workflowSuggestions.file(id),
      }),
      'workflows.answerSuggestion': async ({ id, answer, agentId, options }, { device }) => {
        const from = fromDevice(device)
        switch (answer) {
          case 'start': {
            const first = {
              ...(agentId ? { agentId } : {}),
              ...(options ? { options } : {}),
            }
            const { view, done } = await this.workflowSuggestions.start(id, first, from)
            void done.catch((error: unknown) =>
              this.diagnostics.log(
                'warn',
                `Workflow card ${id} stopped: ${(error as Error).message}`,
              ),
            )
            return view
          }
          case 'decline':
          case 'another':
            return this.workflowSuggestions.decline(id, from, answer === 'another')
          case 'reconsider':
            return this.workflowSuggestions.reconsider(id)
          case 'save':
            return this.workflowSuggestions.save(id, from)
          case 'not_save':
            return this.workflowSuggestions.notSave(id, from)
        }
      },
      'workflows.pin': async ({ workflowId, stepId, pick }) => {
        const entry = await this.workflowLibrary.setPin(workflowId, stepId, pick)
        this.tasks.recheck()
        return entry
      },
      'workflows.settings': () => this.workflowSettings(),
      'workflows.setSettings': (change) => {
        const suggested = this.workflowLibrary.suggest
        this.workflowLibrary.setSettings(change)
        if (this.workflowLibrary.suggest !== suggested) void this.ownSkillsChanged()
        this.tasks.recheck()
        return this.workflowSettings()
      },
      'tasks.list': () => this.tasks.list(),
      'tasks.get': ({ taskId }) => this.tasks.get(taskId),
      'tasks.sessions': ({ taskId }) => {
        const ids = new Set(this.tasks.get(taskId).rounds.flatMap((round) => round.sessionId ?? []))
        return [...ids].flatMap((id) => (sessions.has(id) ? [sessions.summary(id)] : []))
      },
      'tasks.start': ({ from, ...params }) => this.tasks.start(params, from),
      'tasks.review': ({ taskId, roundId, approve, note }) =>
        this.tasks.review(taskId, roundId, approve, note ?? null),
      'tasks.answer': ({ taskId, roundId, outcome, note }) =>
        this.tasks.answer(taskId, roundId, outcome, note ?? null),
      'tasks.retry': ({ taskId, stepId, note }) => this.tasks.retry(taskId, stepId, note ?? null),
      'tasks.cancel': ({ taskId }) => this.tasks.cancel(taskId),
      'tasks.delete': ({ taskId }) => this.tasks.delete(taskId),
      'tasks.note': ({ taskId, text }) => this.tasks.note(taskId, text),
      'tasks.pin': ({ taskId, stepId, pick }) => this.tasks.pinStep(taskId, stepId, pick),
      'tasks.update': ({ taskId, ...change }) => this.tasks.update(taskId, change),
      'tasks.saveWorkflow': ({ taskId }) => this.saveTaskWorkflow(taskId),
      'tasks.publishWorkflow': ({ taskId }) => this.publishTaskWorkflow(taskId),
      'sessions.removeAll': async () => {
        await sessions.removeAll()
        this.options.send({ type: 'host:media-revoke', sessionId: null })
      },
      'permissions.respond': (
        { sessionId, requestId, optionId, note, answers, values },
        { device },
      ) =>
        sessions.respond(
          sessionId,
          requestId,
          answers
            ? { answers }
            : values
              ? { values }
              : { optionId: optionId!, ...(note === undefined ? {} : { note }) },
          fromDevice(device),
        ),
      'git.status': async ({ projectPath, watcher }, { portId }) => {
        const git = this.requireGit()
        const canonical = await this.gitProject(projectPath)
        await this.env.ready()
        if (!this.hub.has(portId)) return this.gitCall((g) => g.status(canonical))
        const key = pathKey(canonical, this.options.platform)
        if (this.gitRetains.add(key, canonical, portId, watcher ?? '')) {
          git.retain(canonical, portId)
        }
        return this.gitCall((g) => g.status(canonical))
      },
      'git.unwatch': async ({ projectPath, watcher }, { portId }) => {
        const git = this.requireGit()
        // The folder may be gone by now; the retained entry still knows its canonical path.
        const canonical = await projects.resolveDirectory(projectPath).catch(() => projectPath)
        const key = pathKey(canonical, this.options.platform)
        const path = this.gitRetains.remove(key, portId, watcher ?? '')
        if (path !== null) git.release(path, portId)
      },
      'git.fetch': ({ projectPath }) => this.gitProjectCall(projectPath, (g, p) => g.fetch(p)),
      'git.pull': ({ projectPath }) => this.gitProjectCall(projectPath, (g, p) => g.pull(p)),
      'git.push': ({ projectPath, remote, branch }) =>
        this.gitProjectCall(projectPath, (g, p) => g.push(p, { remote, branch })),
      'git.publish': ({ projectPath, name, visibility }) =>
        this.gitProjectCall(projectPath, (g, p) => g.publish(p, name, visibility)),
      'git.createPullRequest': ({ projectPath, title, body, base, draft }) =>
        this.gitProjectCall(projectPath, (g, p) =>
          g.createPullRequest(p, { title, body, base, draft }),
        ),
      'git.commit': ({ projectPath, oid }) =>
        this.gitProjectCall(projectPath, (g, p) => g.commit(p, oid)),
      'git.changes': ({ projectPath }) => this.gitProjectCall(projectPath, (g, p) => g.changes(p)),
      'git.commitMessage': ({ projectPath, paths }) => this.commitMessage(projectPath, paths),
      'git.pullRequestDraft': ({ projectPath, base }) => this.pullRequestDraft(projectPath, base),
      'git.incoming': ({ projectPath, from }) =>
        this.gitProjectCall(projectPath, (g, p) => g.incoming(p, from)),
      'git.fileDiff': ({ projectPath, path, oldPath, ref }) =>
        this.gitProjectCall(projectPath, (g, p) => g.fileDiff(p, path, oldPath, ref)),
      'git.branches': ({ projectPath }) =>
        this.gitProjectCall(projectPath, (g, p) => g.branches(p)),
      'git.switchBranch': ({ projectPath, branch, create }) =>
        this.gitProjectCall(projectPath, (g, p) => g.switchBranch(p, branch, create)),
      'git.publishBranch': ({ projectPath, remote }) =>
        this.gitProjectCall(projectPath, (g, p) => g.publishBranch(p, remote)),
      'git.commitChanges': ({ projectPath, message, paths }) =>
        this.gitProjectCall(projectPath, (g, p) => g.commitChanges(p, message, paths)),
      'git.discardChanges': ({ projectPath, paths }) =>
        this.gitProjectCall(projectPath, (g, p) => g.discardChanges(p, paths)),
      'git.pullRequest': ({ url }) => this.gitCall((g) => g.pullRequest(url)),
      'git.issue': ({ url }) => this.gitCall((g) => g.issue(url)),
      'git.watchReferences': ({ urls }, { portId }) => {
        if (this.hub.has(portId)) this.requireGit().watchReferences(portId, urls)
      },
      'git.avatarUrl': ({ login }) => this.gitCall((g) => g.avatarUrl(login)),
      'git.currentPullRequest': ({ projectPath }) =>
        this.gitProjectCall(projectPath, (g, p) => g.currentPullRequest(p)),
      'git.tools': () => this.gitCall((g) => g.tools()),
      'star.state': async () => {
        await this.env.ready()
        return this.star.state()
      },
      'star.add': async () => {
        await this.env.ready()
        return this.star.star()
      },
      'star.dismiss': () => this.star.dismiss(),
      'star.opened': () => this.star.opened(),
      'attachments.add': ({ source, thumb }) =>
        'projectPath' in source
          ? this.filesCall(source.projectPath, async (root) => {
              const found = await this.files.locate(root, source.path)
              return this.attachments.addPath(found.path, found.kind, thumb)
            })
          : this.attachments.add(source, thumb),
      'attachments.read': ({ id }) => this.attachments.read(id),
      'attachments.update': ({ id, thumb, scaled }) => this.attachments.update(id, thumb, scaled),
      'attachments.remove': ({ id }) => this.attachments.remove(id),
      'attachments.held': ({ ids }) => this.attachments.held(ids),
      'files.list': ({ projectPath }) =>
        this.filesCall(projectPath, (root) => this.files.list(root)),
      'files.read': ({ projectPath, path, asText }, { device }) =>
        // A device's media is read through its remote host, never main's media scheme.
        this.filesCall(projectPath, (root) => this.files.read(root, path, asText, device !== null)),
      'files.search': ({ projectPath, query }) =>
        this.filesCall(projectPath, (root) => this.files.search(root, query)),
      'files.agentFolder': ({ sessionId }) => this.agentFiles.folder(sessionId),
      'files.readAgentFile': ({ sessionId, path }) => this.agentFiles.read(sessionId, path),
      'files.write': ({ projectPath, path, text, version }) =>
        this.filesCall(projectPath, (root) => this.files.write(root, path, text, version)),
      'files.create': ({ projectPath, path, kind }) =>
        this.filesCall(projectPath, (root) => this.files.create(root, path, kind)),
      'files.rename': ({ projectPath, from, to }) =>
        this.filesCall(projectPath, (root) => this.files.rename(root, from, to)),
      'files.copy': ({ projectPath, paths, folder }) =>
        this.filesCall(projectPath, (root) => this.files.copy(root, paths, folder)),
      'files.delete': ({ projectPath, paths, permanently }) =>
        this.filesCall(projectPath, (root) => this.files.delete(root, paths, permanently === true)),
      'media.open': async ({ projectPath, path, sessionId }) => {
        const root = await projects.resolveDirectory(projectPath)
        this.assertOpenFolder(root)
        return this.media.open(root, path, sessionId)
      },
      'media.authorize': async ({ projectPath, path, sessionId }, { device }) => {
        // A window has the media scheme; only a device's remote host streams from the path.
        if (!device) {
          throw new HostError('forbidden', 'Only a paired device may call "media.authorize"')
        }
        const root = await projects.resolveDirectory(projectPath)
        this.assertOpenFolder(root)
        return this.media.authorize(root, path, sessionId ?? null)
      },
      'usage.summary': ({ dayStarts, from, to, scope, clock }) =>
        this.usage.summary(dayStarts, from, to, scope, clock),
      'usage.total': ({ from, to }) => this.usage.total(from, to),
      'usage.status': () => this.usage.status(),
      'usage.sync': () => this.usage.sync(),
      'usage.reimport': ({ agentId }) => this.usage.reimport(agentId),
      'usage.clearRecord': () => this.usage.clearRecord(),
      'artifacts.list': async ({ deleted }) =>
        (await artifacts.list({ deleted: deleted ?? false })).map((artifact) => ({
          ...artifact,
          scratch: this.scratch.contains(artifact.project),
        })),
      'artifacts.read': async ({ id, version }) => {
        const read = await artifacts.read(id, version === undefined ? {} : { version })
        return {
          title: read.artifact.title,
          version: read.version.version,
          // A typed artifact's page is its type's viewer, which has no text of its own, and a
          // canvas document need not have an entry page.
          html:
            read.type || !read.files.some((f) => f.path === ARTIFACT_ENTRY)
              ? ''
              : await artifacts.entryText(read),
          type: read.type,
          seen: read.artifact.seen,
          files: read.files.map((file) => ({
            path: file.path,
            size: file.size,
            type: artifactFileType(file.path),
            hash: file.hash,
          })),
        }
      },
      'artifacts.file': async ({ id, version, path }) => {
        const found = await artifacts.read(id, { version })
        const file = found.files.find((f) => f.path === path)
        if (!file) throw new HostError('not_found', t('hostError.noArtifactFile', { path }))
        return {
          type: artifactFileType(path),
          bytes: toArrayBuffer(await artifacts.bytes(found, file)),
        }
      },
      'artifacts.content': async ({ id, version }, { device }) => {
        // A window has main's protocol; only a device's remote host serves the files from disk.
        if (!device) {
          throw new HostError('forbidden', 'Only a paired device may call "artifacts.content"')
        }
        return artifacts.content(id, version)
      },
      'artifacts.versions': async ({ id }) => (await artifacts.versions(id)).map(versionSummary),
      'artifacts.changes': async ({ id, from, to }) => ({
        changes: await artifacts.changes(id, from, to),
      }),
      'artifacts.rename': ({ id, title }) => artifacts.rename(id, title),
      'artifacts.delete': async ({ id, permanently }) => {
        if (permanently) await artifacts.erase(id)
        else await artifacts.delete(id)
      },
      'artifacts.undelete': ({ id }) => artifacts.undelete(id),
      'artifacts.restoreVersion': ({ id, version, baseVersion }) =>
        artifacts.restore({ id, version, baseVersion, author: null }),
      'artifacts.watch': async ({ id }, { portId }) => {
        await artifacts.watch(id, portId)
        // Opening a typed artifact moves its content to a newer format, as a new version.
        void upgradeContent(artifacts, this.artifactTypes, id, (level, message) =>
          this.diagnostics.log(level, message),
        ).catch(() => {})
      },
      'artifacts.export': async ({ id, version, format }) => {
        const found = await artifacts.read(id, { version })
        try {
          const files = await exportVersion(artifacts, found, format)
          return {
            title: found.artifact.title,
            files: files.map((file) => ({ path: file.path, bytes: toArrayBuffer(file.bytes) })),
          }
        } catch (error) {
          if (error instanceof ExportError) throw invalidParams(error.message)
          throw error
        }
      },
      'artifacts.unwatch': ({ id }, { portId }) => artifacts.unwatch(id, portId),
      'artifacts.comments': ({ id }) => artifacts.threads(id),
      'artifacts.comment': ({ id, anchor, body }) =>
        artifacts.addThread(id, { anchor, body, author: { person: OWNER, session: null } }),
      'artifacts.reply': ({ id, threadId, body }) =>
        artifacts.reply(id, threadId, { body, author: { person: OWNER, session: null } }),
      'artifacts.resolve': ({ id, threadId, resolved }) =>
        artifacts.resolve(id, threadId, resolved),
      'artifacts.repin': ({ id, threadId, anchor }) => artifacts.repin(id, threadId, anchor),
      'artifacts.markSent': ({ id, threadIds, sessionId }) =>
        artifacts.markSent(id, threadIds, sessionId),
      'artifacts.editElement': ({ id, baseVersion, path, offset, style, text }) =>
        artifacts.editElement({ id, baseVersion, path, offset, change: { style, text } }),
      'artifacts.view': ({ id, page }, { portId }) => artifacts.view(id, portId, page),
      'artifacts.seen': async ({ id, version }) => ({ seen: await artifacts.see(id, version) }),
      'artifacts.setParams': ({ id, baseVersion, path, values }) =>
        artifacts.setParams({ id, baseVersion, path, values }),
      'artifacts.canvas': ({ id }) => artifacts.canvases.state(id),
      'artifacts.canvasOps': ({ id, ops, client, clientSeq }) =>
        artifacts.canvases.apply(id, ops, client, clientSeq),
      'artifacts.runtime': ({ artifactId, message, stream }, { portId, device }) => {
        // A window's frames reach the runtime through main; only a device's remote host relays.
        if (!device) {
          throw new HostError('forbidden', 'Only a paired device may call "artifacts.runtime"')
        }
        return this.runtimeRequests.fromPort(portId, artifactId, message, stream, (answer) => {
          if (stream !== undefined) {
            this.hub.send([portId], { type: 'artifacts.runtime', stream, answer })
          }
        })
      },
      'artifacts.consent': ({ requestId, allow }, { portId }) =>
        this.consents.answer(requestId, allow, portId),
      'artifacts.consents': () => this.consents.list(),
      'artifacts.revokeConsent': ({ id }) => this.consents.revoke(id),
      'browser.answer': ({ callId, answer }, ctx) => {
        browserApp(ctx)
        if (!this.deviceBrowser.answer(ctx.portId, callId, answer)) {
          throw new HostError('not_found', 'This port was sent no such browser call')
        }
      },
      'browser.waiting': ({ callId, waiting }, ctx) => {
        browserApp(ctx)
        if (this.deviceBrowser.owns(ctx.portId, callId)) {
          this.artifactService.browserWaiting(callId, waiting)
        }
      },
      'browser.origin': ({ sessionId, requestId, origin }, ctx) => {
        browserApp(ctx)
        // Only the app the session's calls go to asks for its page.
        const target = browserTarget(sessions.browserSender(sessionId), this.hub)
        if (target.kind !== 'device' || target.portId !== ctx.portId) {
          throw new HostError('forbidden', 'This port does not drive the session’s browser')
        }
        sessions.browserOriginAsked(sessionId, requestId, origin, ctx.portId)
      },
      'browser.originSettled': ({ requestId, decision }, ctx) => {
        browserApp(ctx)
        sessions.browserOriginSettled(requestId, decision, ctx.portId, fromDevice(ctx.device))
      },
      'browser.handedBack': ({ sessionId, durationMs }, ctx) => {
        browserApp(ctx)
        const target = this.browserTurns.targetOf(sessionId)
        if (target?.kind !== 'device' || target.portId !== ctx.portId) {
          throw new HostError('forbidden', 'This port does not drive the session’s browser')
        }
        sessions.controlHandedBack(sessionId, 'browser', durationMs)
      },
      // The first answer goes to the page, whose waiting call then settles the card.
      'control.answerAsk': ({ sessionId, entryId, outcome }, { device }) => {
        sessions.answerControlAsk(sessionId, entryId, outcome, fromDevice(device))
        const target = this.browserTurns.targetOf(sessionId)
        if (!target || target.kind === 'main') {
          this.options.send({ type: 'host:browser-ask-answer', sessionId, outcome })
        } else {
          this.hub.send([target.portId], { type: 'browser.askAnswered', sessionId, outcome })
        }
      },
      'computer.answerApp': ({ sessionId, entryId, decision }, { device }) => {
        const requestId = sessions.answerComputerApp(
          sessionId,
          entryId,
          decision,
          fromDevice(device),
        )
        if (!this.computer?.answer(requestId, decision)) {
          throw new HostError('not_found', t('session.waiting.app.gone'))
        }
      },
      'sessions.answerProjectMcp': ({ sessionId, entryId, decision }, { device }) => {
        sessions.answerProjectMcp(sessionId, entryId, decision, fromDevice(device))
      },
      'sessions.answerProjectHooks': ({ sessionId, entryId, decision }, { device }) => {
        sessions.answerProjectHooks(sessionId, entryId, decision, fromDevice(device))
      },
      'sessions.answerReport': ({ sessionId, entryId, outcome }, { device }) =>
        sessions.answerReport(sessionId, entryId, outcome, fromDevice(device)),
      'sessions.answerMemory': ({ sessionId, entryId, decision }, { device }) =>
        memoryCall(() => sessions.answerMemory(sessionId, entryId, decision, fromDevice(device))),
      'sessions.undoMemory': ({ sessionId, entryId }) =>
        memoryCall(() => sessions.undoMemory(sessionId, entryId)),
      'memory.overview': () => memoryCall(() => memory.overview()),
      'memory.list': ({ scope }) => memoryCall(() => memory.list(scope)),
      'memory.save': ({ scope, id, draft }) =>
        memoryCall(async () => (await memory.save(scope, id, draft, BY_USER)).entry),
      'memory.remove': ({ scope, id }) =>
        memoryCall(async () => {
          await memory.remove(scope, id, BY_USER)
        }),
      'memory.moveToGlobal': ({ project, id }) =>
        memoryCall(() => memory.moveToGlobal(project, id)),
      'memory.setEnabled': ({ enabled }) =>
        memoryCall(async () => {
          const was = memory.enabled
          await memory.setEnabled(enabled)
          if (memory.enabled !== was) sessions.memorySwitched()
        }),
      'memory.importScan': () => memoryCall(() => memory.importScan()),
      'memory.import': ({ sources, global }) => memoryCall(() => memory.import(sources, global)),
      'computer.stop': ({ sessionId }) => {
        this.computer?.stop(sessionId)
      },
      'computer.takeOver': ({ sessionId }) => {
        this.computer?.takeOver(sessionId)
      },
      'computer.handBack': ({ sessionId }) => {
        this.computer?.handBack(sessionId)
      },
      'computer.show': async ({ sessionId }, { device }) => {
        // The window comes forward on this computer, for someone in front of it.
        if (device) throw new HostError('forbidden', t('hostError.showHere'))
        await this.computer?.show(sessionId)
      },
      'computer.declineSetup': ({ sessionId, entryId }, { device }) => {
        const requestId = sessions.declineComputerSetup(sessionId, entryId, fromDevice(device))
        if (!this.computer?.declineSetup(requestId)) {
          throw new HostError('not_found', t('session.waiting.setup.gone'))
        }
      },
      'browser.answerOrigin': ({ sessionId, entryId, decision }, { device }) => {
        const { owner, requestId } = sessions.answerOrigin(
          sessionId,
          entryId,
          decision,
          fromDevice(device),
        )
        if (owner === '') {
          this.options.send({ type: 'host:browser-origin-decide', sessionId, requestId, decision })
        } else {
          this.hub.send([owner], { type: 'browser.originDecided', sessionId, requestId, decision })
        }
      },
      'devices.answerAccess': ({ sessionId, entryId, decision }, { device }) => {
        sessions.answerDeviceAccess(sessionId, entryId, decision, fromDevice(device))
      },
      'surfaces.answerAccess': ({ sessionId, entryId, decision }, { device }) => {
        sessions.answerSurfaceAccess(sessionId, entryId, decision, fromDevice(device))
      },
      'terminals.revokeAccess': ({ sessionId, terminalId }) =>
        this.revokeTerminal(sessionId, terminalId),
      'devices.revokeAccess': ({ sessionId, deviceId }) => {
        this.artifactService.revokeDevice(sessionId, deviceId)
        sessions.deviceAccessRevoked(sessionId, deviceId)
      },
      'devices.allowed': async () => {
        await this.deviceAccess.ready
        return { deviceIds: this.deviceAccess.list() }
      },
      'devices.forget': ({ deviceId }) => this.deviceAccess.remove(deviceId),
    }
  }
}
