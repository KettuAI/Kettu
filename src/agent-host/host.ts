// The agent host, assembled: state, agents, sessions, git and the ports. start.ts runs it in
// the utility process or under Node.js; tests run it in-process with fakes for the launcher,
// shell and git.

import { DEVICE_ACCESS_WAIT_MS, type DeviceCall, type DeviceCallAnswer } from '@shared/device-agent'
import { DeviceAccessStore } from './devices/access'
import os from 'node:os'
import path from 'node:path'
import { cp, mkdir, rename, rm, stat } from 'node:fs/promises'
import type { AgentOptions, DiagnosticsBundle, HostEvent, McpStatus } from '@shared/agent-host'
import { OWNER } from '@shared/artifact-comments'
import { flushLog, logFolder, redactLogText, writeLog } from '@shared/log/process-log'
import { writeReport } from '@shared/log/report-bundle'
import { parseReportRequest } from '@shared/report'
import { harnessOf, type HarnessId } from '@shared/agents'
import type { RuntimeAnswer } from '@shared/artifact-capabilities'
import { ARTIFACT_ENTRY, artifactFileType } from '@shared/artifact-files'
import { type ArtifactImportResult, type ArtifactSummary, NO_SESSION } from '@shared/artifacts'
import type { AttachmentGrant } from '@shared/attachments'
import type { BrowserCallAnswer, BrowserCallRequest, BrowserOriginAnswer } from '@shared/browser'
import type {
  AgentProcess,
  AttentionFront,
  ArtifactBrief,
  ArtifactContentResult,
  ArtifactExportResult,
  ArtifactListResult,
  HostToMain,
  MainToHost,
  NodeRuntime,
  ReportBuildResult,
} from '@shared/host-control'
import type { ArtifactExportFormat } from '@shared/artifact-types'
import type { Platform } from '@shared/platform'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import type { HostSettings } from '@shared/settings'
import { serverFor, type MarketConnection, type MarketServer } from '@shared/marketplace'
import { HARNESSES_FOLDER, KETTU_HOME_FOLDER } from '@shared/storage'
import type { AgentId, FromDevice } from '@shared/thread'
import { agentOptionsFile, AgentOptionsStore, startModeIn } from './agent-options'
import { listedModels } from './claude/user-settings'
import { STOP_TIMINGS } from './agent-process'
import { AgentTrees } from './agent-trees'
import { readImport } from './artifacts/import'
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
import { answerOf, BROWSER_GONE, browserTarget, DeviceBrowserCalls } from './device-browser'
import { Diagnostics } from './diagnostics'
import { HostError, invalidParams } from './errors'
import { setLocale, t } from './i18n'
import { FilesService } from './files'
import { MediaService } from './media'
import { catalogFile, MarketCatalogService } from './marketplace/catalog'
import { MarketConnectionsService } from './marketplace/connections'
import { parseSignIns } from './marketplace/oauth'
import { McpProxy } from './marketplace/proxy'
import type { CodexRequest } from './marketplace/codex-plugins'
import { MarketPluginsService, pluginsFile } from './marketplace/plugins'
import { MarketSkillsService, skillFor, skillsCatalogFile } from './marketplace/skills'
import {
  ALL_TRANSPORTS,
  keyState,
  libraryServers,
  parseMarketKeys,
  serverHeaders,
  type MarketKeys,
} from './marketplace/servers'
import type { Env } from './find-command'
import type { GitServiceApi, GitServiceDeps } from './git/api'
import { createExec, type ExecRunner } from './git/exec'
import type { SkillsListResponse } from './codex/protocol'
import { completePath } from './path-completion'
import { pathKey } from './paths'
import { PreparedRecords, preparedFile, settingsTargets } from './prepared'
import { processControl, type ProcessControl } from './process-tree'
import { ProjectMcpAnswers } from './project-mcp'
import { Projects } from './projects'
import { claudeCacheTtl, type CacheTtlReader } from './prompt-cache'
import { PortHub, type Handlers, type RequestContext } from './rpc'
import { Attachments, toArrayBuffer } from './attachments'
import { RoutinesManager, type RoutineTimings } from './routines/manager'
import type { RoutineSessionHooksRef } from './routines/hooks'
import type { RoutineClock } from './routines/scheduler'
import type { TaskEngineApi, TaskRuntime } from './tasks/api'
import { createTaskEngine } from './tasks/engine'
import type { TaskSessionHooksRef } from './tasks/hooks'
import { createTaskRuntime } from './tasks/runtime'
import { tasksFile } from './tasks/store'
import { ScratchFolders } from './scratch'
import { createWorktreeGit } from './worktrees/git'
import { WorktreeManager } from './worktrees/manager'
import { ComputerDriver, probePermissions } from './computer/driver'
import { ComputerUse } from './computer/service'
import { SessionManager, type SessionTimings } from './sessions'
import { EnvironmentService, type EnvironmentServiceDeps } from './shell-env'
import {
  agentProcessesFile,
  agentsFile,
  agentUpdatesFile,
  projectsFile,
  projectMcpFile,
  returnedFile,
  routinesFile,
  sessionsFile,
  type AgentsFile,
  type AgentUpdatesFile,
  type JsonFile,
} from './storage'
import { ThreadStore, type ThreadWorkerFactory } from './threads/store'
import { UsageManager, type UsageTimings } from './usage/manager'
import type { LogReader } from './usage/model'
import { LOG_READERS } from './usage/readers'
import { UsageStore, type UsageWorkerFactory } from './usage/store'
import { createValidators } from './validate'

// The agent menu reads a running agent's options again once they are older than this.
const OPTIONS_FRESH_MS = 5 * 60_000
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

/** What a message or answer from a paired device's port keeps of it; none from a window. */
function fromDevice(device: PortDevice | null): FromDevice | undefined {
  return device ? { id: device.id, name: device.name } : undefined
}

export interface HostOptions {
  userDataPath: string
  appVersion: string
  platform: Platform
  nodeRuntime: NodeRuntime
  fakeAgentPath: string | null
  /** The session router's bundle, which a per-session agent's process runs under. */
  sessionRouterPath?: string | null
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
  /** Reads a session's prompt cache lifetime; Claude Code's transcripts by default. */
  cacheTtl?: CacheTtlReader
  /** The desktop app's computer use; the daemon has none. */
  computer?: ComputerHostOptions | null
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

export class AgentHost {
  readonly diagnostics: Diagnostics
  readonly env: EnvironmentService
  readonly projects: Projects
  readonly scratch: ScratchFolders
  private readonly worktrees: WorktreeManager
  readonly agents: AgentManager
  /** What the agents last reported about their accounts and plans, kept across runs. */
  private readonly remembered: JsonFile<AgentsFile>
  /** What the last update check found, so a found update shows after a restart. */
  private readonly updates: JsonFile<AgentUpdatesFile>
  /** Each agent's config options from its last new session, for New session. */
  private readonly agentOptions: AgentOptionsStore
  /** New session's prepared sessions not yet adopted or removed, for the host after a crash. */
  private readonly preparedRecords: PreparedRecords
  /** The agent processes and what they leave behind, until seen gone. */
  private readonly trees: AgentTrees
  readonly sessions: SessionManager
  /** The saved routines and the lifecycle of their runs. */
  readonly routines: RoutinesManager
  /** Tasks: requirements run through workflows of stages, each stage in a session of its own. */
  readonly tasks: TaskEngineApi
  private readonly taskRuntime: TaskRuntime
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
  /** Grants for the media a thread names and the Files pane opens, which main serves. */
  private readonly media: MediaService
  private gitUnsubscribe: (() => void)[] = []
  /** Ports keeping a project's git status live, by path key. */
  private readonly gitRetains = new Map<string, { path: string; ports: Set<string> }>()
  /** Browser calls awaiting main's answer, by the id the call was given. */
  private readonly browserCalls = new Map<number, (answer: BrowserCallAnswer) => void>()
  private readonly deviceCalls = new Map<number, (answer: DeviceCallAnswer) => void>()
  private nextDeviceCall = 1
  private readonly deviceAccess: DeviceAccessStore
  /** Browser calls sent to the desktop apps that sent their turns. */
  private readonly deviceBrowser: DeviceBrowserCalls
  /** The values of the Marketplace servers' inputs from main, held only in memory. */
  private marketKeys: MarketKeys = new Map()
  /** The Marketplace's catalog of MCP servers, from the registry. */
  private readonly marketCatalog: MarketCatalogService
  /** The sign-ins of the Marketplace's OAuth servers. */
  private readonly marketConnections: MarketConnectionsService
  /** Where agents reach the OAuth servers, with a fresh token. */
  private readonly mcpProxy: McpProxy
  /** The sign-ins sent to main that no push has carried back yet, by server id. */
  private readonly unkept = new Map<string, { state: string | null; pushes: number }>()
  /** Claude Code's and Codex's plugins, through each agent's harness. */
  private readonly marketPlugins: MarketPluginsService
  /** The skills catalog, the skills Kettu keeps, and what each agent gets of them. */
  private readonly marketSkills: MarketSkillsService
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
      media: (real, info) => this.media.grantFile(real, info, null),
      describeMedia: (real, info) => this.media.describe(real, info),
    })
    this.deviceAccess = new DeviceAccessStore(options.userDataPath, log)
    this.projects = new Projects({ file: projectsFile(options.userDataPath, log), platform })
    this.scratch = new ScratchFolders(path.join(options.userDataPath, 'scratch'), platform)
    this.remembered = agentsFile(options.userDataPath, log)
    this.updates = agentUpdatesFile(options.userDataPath, log)
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
    this.marketPlugins = new MarketPluginsService({
      file: pluginsFile(options.userDataPath, log),
      log,
      platform,
      agents: () => this.installedAgents(['claude-code', 'codex']),
      program: (agentId) => this.agents.harnessProgram(agentId),
      appServer: (agentId) => this.appServer(agentId),
    })
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
          log,
        })
      : null
    this.artifactService = new ArtifactService({
      data: this.artifactData,
      store: this.artifacts,
      types: this.artifactTypes,
      sessionTitle: (sessionId) => this.sessions.title(sessionId),
      runningTurn: (sessionId) => this.sessions.runningTurn(sessionId),
      sessionOf: (process, id) => this.sessions.sessionOf(process, id),
      subagentCall: (process, id) => this.sessions.isSubagentCall(process, id),
      plan: { set: (sessionId, items) => this.sessions.planSet(sessionId, items) },
      submit: {
        stageOf: (sessionId) => this.tasks.stageOf(sessionId),
        submit: (sessionId, submission) => this.tasks.submit(sessionId, submission),
      },
      wrote: (sessionId, write) => this.sessions.artifactWritten(sessionId, write),
      browserCall: (request) => this.browserCall(request),
      browserSession: (sessionId) => this.sessions.browserSession(sessionId),
      devices: {
        call: (call) => this.deviceCall(call),
        agentName: (sessionId) => this.sessions.agentName(sessionId),
        ask: (sessionId, deviceId, deviceName) =>
          this.sessions.deviceAccessAsked(sessionId, deviceId, deviceName, DEVICE_ACCESS_WAIT_MS),
        alwaysAllowed: (deviceId) => this.deviceAccess.has(deviceId),
        allowAlways: (deviceId) => this.deviceAccess.add(deviceId),
      },
      sessionProject: (sessionId) => this.sessions.sessionProject(sessionId),
      sessionFolder: (sessionId) => this.sessions.sessionFolder(sessionId),
      ...(this.computer ? { computer: this.computer } : {}),
      proxy: this.mcpProxy,
      sessions: {
        info: (sessionId) => this.sessions.sessionInfo(sessionId),
        list: (projectPath) => this.sessions.toolSessions(projectPath),
        lastReply: (sessionId) => this.sessions.lastReply(sessionId),
        rename: (sessionId, title) => this.sessions.renameByAgent(sessionId, title),
        archiveAfterTurn: (sessionId, agentName) =>
          this.sessions.archiveWhenIdle(sessionId, agentName),
        archiveNow: (sessionId, agentName) => this.sessions.archiveByAgent(sessionId, agentName),
        start: (callerId, params) => this.sessions.startFromTool(callerId, params),
        send: (sessionId, text, from) => this.sessions.sendFromTool(sessionId, text, from),
        started: (callerId) => this.sessions.startedBy(callerId),
        name: (sessionId) => this.sessions.toolName(sessionId),
        agentName: (sessionId) => this.sessions.agentName(sessionId),
        agentLabel: (agentId) => this.agents.name(agentId),
        history: (sessionId) => this.sessions.historyTurns(sessionId),
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
    const adaptersDir = path.join(
      options.homeDir ?? os.homedir(),
      KETTU_HOME_FOLDER,
      HARNESSES_FOLDER,
    )
    this.agents = new AgentManager({
      catalog,
      platform,
      nodeRuntime: options.nodeRuntime,
      appVersion: options.appVersion,
      env: this.env,
      diagnostics: this.diagnostics,
      launcher: options.launcher ?? processLauncher(platform),
      settings: () => this.settings,
      reportsDir: path.join(options.userDataPath, 'agent-reports'),
      adaptersDir,
      sessionRouterPath: options.sessionRouterPath ?? null,
      ...(options.detect ? { detect: options.detect } : {}),
      ...(options.protocols ? { protocols: options.protocols } : {}),
      ...(options.drivers ? { drivers: options.drivers } : {}),
      ...(options.agentTimings ? { timings: options.agentTimings } : {}),
      status: (status) => {
        this.hub.broadcast({ type: 'agent.status', status })
        this.routines.limitsChanged(status.id)
        this.tasks.limitsChanged(status.id)
      },
      removed: (agentId) => this.hub.broadcast({ type: 'agent.removed', agentId }),
      processes: (processes) => this.reportProcesses(processes),
      trees: this.trees,
      authCommands: (commands) => options.send({ type: 'host:auth-commands', commands }),
      remember: (file) => this.remembered.save(file),
      rememberUpdates: (file) => this.updates.save(file),
      launchEnv: (agentId, env) => this.marketSkills.launchEnv(agentId, env),
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
    this.sessions = new SessionManager({
      platform,
      agents: this.agents,
      projects: this.projects,
      scratch: this.scratch,
      worktrees: this.worktrees,
      file: sessionsFile(options.userDataPath, log),
      returned: returnedFile(options.userDataPath, log),
      projectMcp: new ProjectMcpAnswers(projectMcpFile(options.userDataPath, log)),
      portOpen: (portId) => this.hub.has(portId),
      portDevice: (portId) => this.hub.deviceOf(portId),
      threads: this.threads,
      reportsDir: path.join(options.userDataPath, 'agent-reports'),
      attachments: this.attachments,
      mcp: {
        servers: (sessionId, record, connection) =>
          this.agents.mcpServersByName(record.agentId)
            ? this.artifactService.folderServers(connection, record.projectPath, sessionId)
            : this.artifactService.servers(sessionId, record.projectPath),
        library: (sessionId, record, connection, transports, taken) =>
          libraryServers(
            this.settings.marketplace.mcp,
            this.marketKeys,
            record.agentId,
            transports,
            {
              platform,
              taken,
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
        },
        turnEnded: (sessionId) => {
          this.artifacts.stopUsing(sessionId)
          this.computer?.turnEnded(sessionId)
        },
      },
      skills: (agentId) => this.marketSkills.sessionOptions(agentId),
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
        attention: (sessionId, kind, title, body, request) =>
          options.send({
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
          }),
        badge: (count) => options.send({ type: 'host:badge', count }),
        waiting: (sessions) => options.send({ type: 'host:waiting', sessions }),
        seen: (sessionId) => options.send({ type: 'host:seen', sessionId }),
        busy: (counts) => options.send({ type: 'host:busy-changed', ...counts }),
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
          options.send({
            type: 'host:attention',
            sessionId,
            kind,
            title,
            body,
            front: this.front(sessionId),
          }),
        paused: (agentId, title, body) =>
          options.send({ type: 'host:attention', kind: 'routine-paused', agentId, title, body }),
      },
    })
    routineHooks.current = this.routines.hooks
    this.taskRuntime = createTaskRuntime({
      platform,
      sessions: this.sessions,
      agents: this.agents,
      worktrees: this.worktrees,
      git: () => this.git,
      exec: this.execRunner.exec,
      libraryDir: path.join(options.userDataPath, 'workflows'),
      resolveProject: (value) => this.projects.resolveDirectory(value),
      attention: (kind, sessionId, title, body) =>
        options.send({
          type: 'host:attention',
          sessionId,
          kind,
          title,
          body,
          front: this.front(sessionId),
        }),
      engine: () => this.tasks,
    })
    this.tasks = createTaskEngine({
      file: tasksFile(options.userDataPath, log),
      log,
      runtime: this.taskRuntime,
      events: {
        changed: (task) => this.broadcast({ type: 'task.changed', task }),
        removed: (taskId) => this.broadcast({ type: 'task.removed', taskId }),
        run: (run) => this.broadcast({ type: 'task.run', run }),
      },
    })
    taskHooks.current = {
      isStage: (sessionId) => this.tasks.stageOf(sessionId) !== null,
      turnEnded: (sessionId) => this.tasks.turnEnded(sessionId),
      waiting: (sessionId, waiting) => this.tasks.waiting(sessionId, waiting),
      sessionGone: (sessionId) => this.tasks.sessionGone(sessionId),
    }
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
    this.projects.onChange((projects) => {
      this.broadcast({ type: 'projects.changed', projects })
      this.sendFolders()
    })
    this.env.onChange((info) => {
      this.broadcast({ type: 'environment.changed', info })
      this.git?.setEnvironment(this.env.agentEnv() as NodeJS.ProcessEnv)
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
      path.join(options.homeDir ?? os.homedir(), KETTU_HOME_FOLDER, HARNESSES_FOLDER),
      (message) => writeLog('warn', 'host', message),
    )
    const host = new AgentHost(options)
    const [, , , remembered, updates] = await Promise.all([
      host.scratch.ready(),
      host.projects.load(),
      host.sessions.load(),
      host.remembered.load(),
      host.updates.load(),
      host.trees.load(),
      host.agentOptions.load(),
      host.preparedRecords.load(),
      host.attachments.load(),
      host.artifactService.start(),
      host.routines.load(),
    ])
    host.agents.restore(remembered)
    host.agents.restoreUpdates(updates)
    host.routines.start()
    // After the sessions it carries on in and the agents' limits it picks by.
    await host.tasks.load()
    void host.marketSkills.sync()
    host.sendFolders()
    void host.sessions.checkWorktrees()
    host.usage.start()
    host.artifacts.start()
    options.send({ type: 'host:service-port', port: host.artifactService.listeningPort })
    options.send({ type: 'host:ready' })
    void host.trees.stopLeftovers()
    host.agents.startLimitReads()
    void host.agents.detectAll().then(() => {
      host.agents.scheduleUpdateChecks()
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

  private wireGit(git: GitServiceApi): void {
    git.setBackgroundFetch(this.settings.git.backgroundFetch)
    this.gitUnsubscribe = [
      git.onChanged((status) =>
        this.sendToRetainers(status.projectPath, { type: 'git.changed', status }),
      ),
      git.onPullRequest((projectPath, pr) =>
        this.sendToRetainers(projectPath, { type: 'git.pr', projectPath, pr }),
      ),
      git.onTools((tools) => this.broadcast({ type: 'git.tools', tools })),
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

  /** Who shows a session in front now: any window or device, and which devices. */
  private front(sessionId: string): AttentionFront {
    const ports = this.sessions.showing(sessionId)
    const devices = ports.flatMap((portId) => this.hub.deviceOf(portId)?.id ?? [])
    return { any: ports.length > 0, devices: [...new Set(devices)] }
  }

  private sendToRetainers(projectPath: string, event: HostEvent): void {
    const retained = this.gitRetains.get(pathKey(projectPath, this.options.platform))
    if (retained) this.hub.send(retained.ports, event)
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

  private portClosed(portId: string): void {
    this.runtimeRequests.portClosed(portId)
    this.consents.portClosed(portId)
    this.deviceBrowser.portClosed(portId)
    this.sessions.portClosed(portId)
    this.artifacts.portClosed(portId)
    for (const [key, retained] of this.gitRetains) {
      if (retained.ports.delete(portId) && retained.ports.size === 0) this.gitRetains.delete(key)
    }
    this.git?.releaseAll(portId)
  }

  /** `host:settings`: binary overrides, the proxy and background fetch, applied live. */
  async updateSettings(next: HostSettings): Promise<void> {
    const previous = this.settings
    this.settings = next
    if (setLocale(next.locale))
      this.broadcast({ type: 'environment.changed', info: this.env.info() })
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
    this.marketChanged(previous.marketplace.mcp, this.marketKeys)
    if (JSON.stringify(previous.marketplace.skills) !== JSON.stringify(next.marketplace.skills)) {
      void this.skillsChanged(previous.marketplace.skills)
    }
    const removed = await this.agents.settingsChanged(previous, next)
    const turnedOff = next.disabledAgents.filter((id) => !previous.disabledAgents.includes(id))
    const gone = [...removed, ...turnedOff]
    if (gone.length > 0) await this.sessions.agentsRemoved(gone)
  }

  /**
   * `host:market-keys`: every value of the Marketplace servers' inputs, replacing those before.
   * They stay in memory and go only into what agents are handed; a malformed message is dropped.
   */
  setMarketKeys(values: unknown, oauth?: unknown): void {
    const keys = parseMarketKeys(values)
    const signIns = oauth === undefined ? undefined : parseSignIns(oauth)
    if (!keys || signIns === null) {
      this.diagnostics.log('warn', 'host:market-keys was not a map of values; ignored')
      return
    }
    const previous = this.marketKeys
    this.marketKeys = keys
    this.marketChanged(this.settings.marketplace.mcp, previous)
    if (signIns) this.signInsPushed(signIns)
    this.hub.broadcast({ type: 'market.keysChanged' })
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
    const options = { platform: this.options.platform, oauth }
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
    if (!request) throw new HostError('agent_unavailable', 'The agent takes no such request')
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

  /** The computer slept or woke, so the routines' timer starts over from the wall clock. */
  power(state: 'suspend' | 'resume'): void {
    this.routines.power(state)
    this.tasks.power(state)
  }

  busy(requestId: number): void {
    this.options.send({ type: 'host:busy', requestId, sessions: this.sessions.busy() })
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
    let agentId = this.settings.defaultAgent
    if (agentId === null) {
      const sessions = project === null ? this.sessions.list() : this.sessions.list(project)
      agentId = sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.agentId ?? null
    }
    if (agentId === null || !this.agents.has(agentId) || this.agents.isDisabled(agentId))
      return null
    if (!QUESTION_HARNESSES.has(harnessOf(agentId))) return null
    return { id: agentId, name: this.agents.name(agentId) }
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
   * with its answer, or a failure if the host stops.
   */
  browserCall(request: BrowserCallRequest): Promise<BrowserCallAnswer> {
    const target = browserTarget(this.sessions.browserSender(request.sessionId), this.hub)
    if (target.kind === 'gone') {
      return Promise.resolve({ error: { code: 'unavailable', message: BROWSER_GONE } })
    }
    if (target.kind === 'device') return this.deviceBrowser.call(target.portId, request)
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
      })
    })
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
    const callId = this.nextDeviceCall++
    return new Promise<DeviceCallAnswer>((resolve) => {
      this.deviceCalls.set(callId, resolve)
      this.options.send({ type: 'host:device-call', callId, call })
    })
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
  }

  /** Stops every agent with the documented sequence, flushes the state files, then reports. */
  shutdown(): Promise<void> {
    this.stopping ??= (async () => {
      await this.routines.shutdown()
      await this.tasks.flush()
      this.sessions.shutdown()
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
        this.trees.close(),
        this.agentOptions.flush(),
        this.preparedRecords.flush(),
        this.attachments.flush(),
        this.marketCatalog.flush(),
        this.marketPlugins.flush(),
        this.marketSkills.flush(),
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
    const { agents, sessions, projects, artifacts, routines } = this
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
      'agents.authenticate': ({ agentId, methodId }) => agents.authenticate(agentId, methodId),
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
      'agents.details': ({ agentId }) => agents.details(agentId),
      'agents.claudeSettings': ({ agentId }) =>
        agents.claudeSettings(agentId, listedModels(this.agentOptions.get(agentId)?.config)),
      'agents.setClaudeSetting': ({ agentId, change }) => agents.setClaudeSetting(agentId, change),
      'agents.refreshAccount': ({ agentId, force }) => agents.refreshAccount(agentId, { force }),
      'agents.options': () => this.agentOptions.list().map((o) => this.withStartMode(o)),
      'mcp.status': () => this.mcpStatus(),
      'market.catalog': ({ refresh }) => this.marketCatalog.catalog(refresh === true),
      'market.search': ({ query }) => this.marketCatalog.search(query),
      'market.keys': () => keyState(this.settings.marketplace.mcp, this.marketKeys),
      'market.connect': ({ serverId }) => this.marketConnections.connect(serverId),
      'market.cancelConnect': ({ loginId }) => this.marketConnections.cancel(loginId),
      'market.disconnect': ({ serverId }) => this.marketConnections.disconnect(serverId),
      'market.connections': () => this.marketConnections.view(),
      'market.plugins': ({ refresh }) => this.marketPlugins.plugins(refresh === true),
      'market.pluginDetails': ({ agentId, pluginId }) =>
        this.marketPlugins.details(agentId, pluginId),
      'market.pluginLogo': ({ pluginId }) => this.marketPlugins.logo(pluginId),
      'market.installPlugin': ({ agentId, pluginId, scope, projectPath }) =>
        this.marketPlugins.install(agentId, pluginId, scope, projectPath ?? null),
      'market.uninstallPlugin': ({ agentId, pluginId, scope, projectPath }) =>
        this.marketPlugins.uninstall(agentId, pluginId, scope, projectPath ?? null),
      'market.setPluginEnabled': ({ agentId, pluginId, enabled, scope, projectPath }) =>
        this.marketPlugins.setEnabled(agentId, pluginId, enabled, scope, projectPath ?? null),
      'market.addMarketplace': ({ agentId, source }) =>
        this.marketPlugins.addMarketplace(agentId, source),
      'market.removeMarketplace': ({ agentId, name }) =>
        this.marketPlugins.removeMarketplace(agentId, name),
      'market.skills': ({ refresh }) => this.marketSkills.skills(refresh === true),
      'market.addSkill': ({ source }) => this.marketSkills.add(source),
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
        return sessions.create(device ? { ...params, device: fromDevice(device) } : params, portId)
      },
      'sessions.prepare': (params, { portId }) => sessions.prepare(params, portId),
      'sessions.discard': ({ sessionId }) => sessions.discard(sessionId),
      'sessions.import': (params) => sessions.importSession(params),
      'sessions.open': ({ sessionId }) => sessions.open(sessionId),
      'sessions.snapshot': ({ sessionId, from }) => sessions.snapshot(sessionId, from),
      'sessions.page': ({ sessionId, before, from }) => sessions.page(sessionId, before, from),
      'sessions.outline': ({ sessionId }) => sessions.outline(sessionId),
      'sessions.outlineTitles': ({ sessionId }) => sessions.outlineTitles(sessionId),
      'sessions.watch': ({ sessionId }, { portId }) => sessions.watch(sessionId, portId),
      'sessions.unwatch': ({ sessionId }, { portId }) => sessions.unwatch(sessionId, portId),
      'sessions.show': ({ sessionIds }, { portId }) => sessions.show(sessionIds, portId),
      'sessions.prompt': ({ sessionId, content }, { portId, device }) =>
        sessions.prompt(sessionId, content, portId, fromDevice(device)),
      'sessions.cancel': ({ sessionId }) => sessions.cancel(sessionId),
      'sessions.stopTask': ({ sessionId, taskId }) => sessions.stopTask(sessionId, taskId),
      'sessions.taskOutput': ({ sessionId, taskId }) => sessions.taskOutput(sessionId, taskId),
      'sessions.retry': ({ sessionId }, { portId }) => sessions.retry(sessionId, portId),
      'sessions.fork': ({ sessionId, entryId, worktree }) =>
        sessions.fork(sessionId, entryId, worktree),
      'worktrees.inspect': ({ sessionId }) =>
        this.gitCall(() => sessions.inspectWorktree(sessionId)),
      'worktrees.remove': ({ sessionId, branch, expected }) =>
        this.gitCall(() => sessions.removeWorktree(sessionId, branch, expected)),
      'worktrees.retrySetup': ({ sessionId }) => sessions.retryWorktreeSetup(sessionId),
      'worktrees.skipSetup': ({ sessionId }) => sessions.skipWorktreeSetup(sessionId),
      'worktrees.setupLog': ({ sessionId }) => ({ log: sessions.worktreeSetupLog(sessionId) }),
      'sessions.switchAgent': (params, { portId, device }) =>
        sessions.switchAgent(params, portId, fromDevice(device)),
      'sessions.context': ({ sessionId }) => sessions.context(sessionId),
      'sessions.queue': ({ sessionId, content }, { portId, device }) =>
        sessions.queue(sessionId, content, portId, fromDevice(device)),
      'sessions.unqueue': ({ sessionId, itemId }) => sessions.unqueue(sessionId, itemId),
      'sessions.steer': ({ sessionId, itemId }) => sessions.steer(sessionId, itemId),
      'sessions.sendNow': ({ sessionId, itemId }) => sessions.sendNow(sessionId, itemId),
      'sessions.resumeQueue': ({ sessionId }) => sessions.resumeQueue(sessionId),
      'sessions.blob': ({ sessionId, hash }) => sessions.blob(sessionId, hash),
      'sessions.setConfigOption': ({ sessionId, optionId, value }) =>
        sessions.setConfigOption(sessionId, optionId, value),
      'sessions.rename': ({ sessionId, title }) => sessions.rename(sessionId, title),
      'sessions.close': ({ sessionId }) => sessions.close(sessionId),
      'sessions.pin': ({ sessionId, pinned }) => sessions.pin(sessionId, pinned),
      'sessions.archive': ({ sessionId }) => sessions.archive(sessionId),
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
      'tasks.list': () => this.tasks.list(),
      'tasks.get': ({ taskId }) => this.tasks.get(taskId),
      'tasks.create': (draft) => this.tasks.create(draft, 'user'),
      'tasks.start': ({ taskId }) => this.tasks.start(taskId),
      'tasks.pause': ({ taskId }) => this.tasks.pause(taskId),
      'tasks.resume': ({ taskId }) => this.tasks.resume(taskId),
      'tasks.cancel': ({ taskId }) => this.tasks.cancel(taskId),
      'tasks.decide': (decision) => this.tasks.decide(decision),
      'tasks.markSeen': ({ taskId }) => this.tasks.markSeen(taskId),
      'tasks.workflows': ({ projectPath }) => this.taskRuntime.workflows(projectPath),
      'tasks.tiers': () => this.tasks.tiers(),
      'tasks.setTiers': (tiers) => this.tasks.setTiers(tiers),
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
      'git.status': async ({ projectPath }, { portId }) => {
        const git = this.requireGit()
        const canonical = await this.gitProject(projectPath)
        await this.env.ready()
        if (!this.hub.has(portId)) return this.gitCall((g) => g.status(canonical))
        const key = pathKey(canonical, this.options.platform)
        let retained = this.gitRetains.get(key)
        if (!retained) {
          retained = { path: canonical, ports: new Set() }
          this.gitRetains.set(key, retained)
        }
        if (!retained.ports.has(portId)) {
          retained.ports.add(portId)
          git.retain(canonical, portId)
        }
        return this.gitCall((g) => g.status(canonical))
      },
      'git.unwatch': async ({ projectPath }, { portId }) => {
        const git = this.requireGit()
        // The folder may be gone by now; the retained entry still knows its canonical path.
        const canonical = await projects.resolveDirectory(projectPath).catch(() => projectPath)
        const key = pathKey(canonical, this.options.platform)
        const retained = this.gitRetains.get(key)
        if (!retained?.ports.delete(portId)) return
        if (retained.ports.size === 0) this.gitRetains.delete(key)
        git.release(retained.path, portId)
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
      'files.write': ({ projectPath, path, text, version }) =>
        this.filesCall(projectPath, (root) => this.files.write(root, path, text, version)),
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
          files: read.files.map((file) => ({
            path: file.path,
            size: file.size,
            type: artifactFileType(file.path),
          })),
        }
      },
      'artifacts.file': async ({ id, version, path }) => {
        const found = await artifacts.read(id, { version })
        const file = found.files.find((f) => f.path === path)
        if (!file) throw new HostError('not_found', `${id} version ${version} has no file ${path}`)
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
      'artifacts.markSent': ({ id, threadIds, sessionId }) =>
        artifacts.markSent(id, threadIds, sessionId),
      'artifacts.editElement': ({ id, baseVersion, path, offset, style, text }) =>
        artifacts.editElement({ id, baseVersion, path, offset, change: { style, text } }),
      'artifacts.view': ({ id, page }, { portId }) => artifacts.view(id, portId, page),
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
      'computer.answerApp': ({ sessionId, entryId, decision }, { device }) => {
        const requestId = sessions.answerComputerApp(
          sessionId,
          entryId,
          decision,
          fromDevice(device),
        )
        if (!this.computer?.answer(requestId, decision)) {
          throw new HostError('not_found', `No app waits in ${entryId}`)
        }
      },
      'sessions.answerProjectMcp': ({ sessionId, entryId, decision }, { device }) => {
        sessions.answerProjectMcp(sessionId, entryId, decision, fromDevice(device))
      },
      'computer.stop': ({ sessionId }) => {
        this.computer?.stop(sessionId)
      },
      'computer.declineSetup': ({ sessionId, entryId }, { device }) => {
        const requestId = sessions.declineComputerSetup(sessionId, entryId, fromDevice(device))
        if (!this.computer?.declineSetup(requestId)) {
          throw new HostError('not_found', `No setup waits in ${entryId}`)
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
      'devices.allowed': async () => {
        await this.deviceAccess.ready
        return { deviceIds: this.deviceAccess.list() }
      },
      'devices.forget': ({ deviceId }) => this.deviceAccess.remove(deviceId),
    }
  }
}
