// The agent host, assembled: state, agents, sessions, git and the ports. index.ts runs it in
// the utility process; tests run it in-process with fakes for the launcher, shell and git.

import os from 'node:os'
import path from 'node:path'
import type { DiagnosticsBundle, HostEvent } from '@shared/agent-host'
import { type ArtifactImportResult, NO_SESSION } from '@shared/artifacts'
import type { AttachmentGrant } from '@shared/attachments'
import type { AgentProcess, ArtifactContentResult, HostToMain } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { HostSettings } from '@shared/settings'
import { agentOptionsFile, AgentOptionsStore } from './agent-options'
import { STOP_TIMINGS } from './agent-process'
import { AgentTrees } from './agent-trees'
import { readImport } from './artifacts/import'
import { ArtifactService } from './artifacts/service'
import { ArtifactError, ArtifactStore, versionSummary } from './artifacts/store'
import {
  AgentManager,
  processLauncher,
  type AgentLauncher,
  type AgentManagerDeps,
  type AgentTimings,
} from './agents'
import { buildCatalog } from './catalog'
import { Diagnostics } from './diagnostics'
import { HostError } from './errors'
import { setLocale, t } from './i18n'
import { FilesService } from './files'
import { MediaService } from './media'
import type { Env } from './find-command'
import type { GitServiceApi, GitServiceDeps } from './git/api'
import { createExec, type ExecRunner } from './git/exec'
import { pathKey } from './paths'
import { processControl, type ProcessControl } from './process-tree'
import { Projects } from './projects'
import { claudeCacheTtl, type CacheTtlReader } from './prompt-cache'
import { PortHub, type Handlers, type PortChannel } from './rpc'
import { Attachments } from './attachments'
import { ScratchFolders } from './scratch'
import { SessionManager, type SessionTimings } from './sessions'
import { EnvironmentService, type EnvironmentServiceDeps } from './shell-env'
import {
  agentProcessesFile,
  agentsFile,
  agentUpdatesFile,
  projectsFile,
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

export interface HostOptions {
  userDataPath: string
  appVersion: string
  platform: Platform
  electronPath: string
  fakeAgentPath: string | null
  settings: HostSettings
  baseEnv: Env
  send(message: HostToMain): void
  /** The git service, or how to make one with the host's log; without it every `git.*` fails. */
  git?: GitServiceApi | ((deps: GitServiceDeps) => GitServiceApi) | null
  launcher?: AgentLauncher
  resolveEnv?: EnvironmentServiceDeps['resolve']
  probeNode?: EnvironmentServiceDeps['probe']
  detect?: AgentManagerDeps['detect']
  agentTimings?: Partial<AgentTimings>
  sessionTimings?: Partial<SessionTimings>
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
}

export class AgentHost {
  readonly diagnostics: Diagnostics
  readonly env: EnvironmentService
  readonly projects: Projects
  readonly scratch: ScratchFolders
  readonly agents: AgentManager
  /** What the agents last reported about their accounts and plans, kept across runs. */
  private readonly remembered: JsonFile<AgentsFile>
  /** What the last update check found, so a found update shows after a restart. */
  private readonly updates: JsonFile<AgentUpdatesFile>
  /** Each agent's config options from its last new session, for New session. */
  private readonly agentOptions: AgentOptionsStore
  /** The agent processes and what they leave behind, until seen gone. */
  private readonly trees: AgentTrees
  readonly sessions: SessionManager
  /** The attachments of drafts and queued prompts, until sent or removed. */
  readonly attachments: Attachments
  /** Every session's thread, read a page at a time, in a worker of its own. */
  readonly threads: ThreadStore | null
  /** OverBench's record and the agents' logs, in a worker of its own. */
  readonly usage: UsageManager
  /** Every project's artifacts, kept in the thread database and the data folder. */
  readonly artifacts: ArtifactStore
  /** The `overbench` MCP server, through which the sessions' agents reach the artifacts. */
  readonly artifactService: ArtifactService
  readonly hub: PortHub
  private settings: HostSettings
  private readonly git: GitServiceApi | null
  /** Runs git for the project's files, with the agent environment. */
  private readonly execRunner: ExecRunner
  private readonly files: FilesService
  /** Grants for the images a thread names, which main serves. */
  private readonly media: MediaService
  private gitUnsubscribe: (() => void)[] = []
  /** Ports keeping a project's git status live, by path key. */
  private readonly gitRetains = new Map<string, { path: string; ports: Set<string> }>()
  private lastProcesses = '[]'
  private sentFolders: string | null = null
  private stopping: Promise<void> | null = null

  private constructor(private readonly options: HostOptions) {
    const { platform } = options
    this.settings = options.settings
    setLocale(options.settings.locale)
    this.diagnostics = new Diagnostics({ mirrorTraffic: options.mirrorTraffic ?? false })
    const log = this.diagnostics.log.bind(this.diagnostics)
    this.diagnostics.onLog((entry) =>
      options.send({ type: 'host:log', level: entry.level, message: entry.message }),
    )
    this.env = new EnvironmentService({
      platform,
      electronPath: options.electronPath,
      baseEnv: options.baseEnv,
      ...(options.resolveEnv ? { resolve: options.resolveEnv } : {}),
      ...(options.probeNode ? { probe: options.probeNode } : {}),
    })
    this.env.setProxy(options.settings.proxy)
    this.execRunner = createExec(() => this.env.agentEnv() as NodeJS.ProcessEnv)
    this.files = new FilesService({ exec: this.execRunner.exec, platform })
    this.media = new MediaService({
      platform,
      homeDir: options.homeDir ?? os.homedir(),
      names: (sessionId, text) => this.sessions.names(sessionId, text),
      grant: (grant) => options.send({ type: 'host:media-grant', grant }),
    })
    this.projects = new Projects({ file: projectsFile(options.userDataPath, log), platform })
    this.scratch = new ScratchFolders(path.join(options.userDataPath, 'scratch'), platform)
    this.remembered = agentsFile(options.userDataPath, log)
    this.updates = agentUpdatesFile(options.userDataPath, log)
    this.agentOptions = new AgentOptionsStore({
      file: agentOptionsFile(options.userDataPath, log),
      changed: (changed) => this.hub.broadcast({ type: 'agent.options', options: changed }),
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
      changed: () => this.hub.broadcast({ type: 'artifacts.changed' }),
      version: (portIds, id, version) =>
        this.hub.send(portIds, { type: 'artifacts.version', id, version }),
      activity: (portIds, activity) =>
        this.hub.send(portIds, { type: 'artifacts.activity', ...activity }),
    })
    this.artifactService = new ArtifactService({
      store: this.artifacts,
      sessionTitle: (sessionId) => this.sessions.title(sessionId),
      runningTurn: (sessionId) => this.sessions.runningTurn(sessionId),
      sessionOf: (process, id) => this.sessions.sessionOf(process, id),
      linked: (sessionId, tool, link) => this.sessions.linkArtifactCall(sessionId, tool, link),
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
      env: async () => {
        await this.env.ready()
        return this.env.agentEnv()
      },
      isScratch: (folder) => this.scratch.contains(folder),
      log,
      changed: () => this.hub.broadcast({ type: 'usage.changed' }),
      status: (status) => this.hub.broadcast({ type: 'usage.status', status }),
      ...(options.usageTimings ? { timings: options.usageTimings } : {}),
    })
    this.agents = new AgentManager({
      catalog: buildCatalog(options.fakeAgentPath),
      platform,
      electronPath: options.electronPath,
      appVersion: options.appVersion,
      env: this.env,
      diagnostics: this.diagnostics,
      launcher: options.launcher ?? processLauncher(platform),
      settings: () => this.settings,
      reportsDir: path.join(options.userDataPath, 'agent-reports'),
      adaptersDir: path.join(options.userDataPath, 'agents'),
      ...(options.detect ? { detect: options.detect } : {}),
      ...(options.agentTimings ? { timings: options.agentTimings } : {}),
      status: (status) => this.hub.broadcast({ type: 'agent.status', status }),
      processes: (processes) => this.reportProcesses(processes),
      trees: this.trees,
      authCommands: (commands) => options.send({ type: 'host:auth-commands', commands }),
      remember: (file) => this.remembered.save(file),
      rememberUpdates: (file) => this.updates.save(file),
    })
    this.sessions = new SessionManager({
      platform,
      agents: this.agents,
      projects: this.projects,
      scratch: this.scratch,
      file: sessionsFile(options.userDataPath, log),
      threads: this.threads,
      attachments: this.attachments,
      mcp: {
        servers: (sessionId, record, connection) =>
          this.agents.mcpServersByName(record.agentId)
            ? this.artifactService.folderServers(connection, record.projectPath, sessionId)
            : this.artifactService.servers(sessionId, record.projectPath),
        detached: (sessionId) => {
          this.artifactService.revoke(sessionId)
          this.artifacts.stopEditing(sessionId)
        },
        turnEnded: (sessionId) => this.artifacts.stopEditing(sessionId),
      },
      usage: this.usage,
      cacheTtl:
        options.cacheTtl ??
        claudeCacheTtl({
          platform,
          home: options.homeDir ?? os.homedir(),
          env: async () => {
            await this.env.ready()
            return this.env.agentEnv()
          },
          log,
        }),
      diagnostics: this.diagnostics,
      git: () => this.git,
      options: this.agentOptions,
      ...(options.sessionTimings ? { timings: options.sessionTimings } : {}),
      events: {
        patches: (batch, portIds) => this.hub.send(portIds, { type: 'session.patches', batch }),
        summary: (summary) => {
          this.hub.broadcast({ type: 'session.summary', summary })
          if (summary.scratch) this.sendFolders()
        },
        removed: (sessionId) => {
          this.hub.broadcast({ type: 'session.removed', sessionId })
          this.sendFolders()
        },
        attention: (sessionId, kind, title, body) =>
          options.send({ type: 'host:attention', sessionId, kind, title, body }),
        badge: (count) => options.send({ type: 'host:badge', count }),
      },
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
    const host = new AgentHost(options)
    const [, , , remembered, updates] = await Promise.all([
      host.scratch.ready(),
      host.projects.load(),
      host.sessions.load(),
      host.remembered.load(),
      host.updates.load(),
      host.trees.load(),
      host.agentOptions.load(),
      host.attachments.load(),
      host.artifactService.start(),
    ])
    host.agents.restore(remembered)
    host.agents.restoreUpdates(updates)
    host.sendFolders()
    host.usage.start()
    host.artifacts.start()
    options.send({ type: 'host:ready' })
    void host.trees.stopLeftovers()
    void host.agents.detectAll().then(() => host.agents.scheduleUpdateChecks())
    return host
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
      git.onSessionEvents((sessionId, events) => this.sessions.gitEvents(sessionId, events)),
    ]
  }

  /** The folders terminals may open in, sent when they change: the projects and scratch folders. */
  private sendFolders(): void {
    const paths = [...this.projects.paths(), ...this.sessions.scratchFolders()]
    const key = paths.join('\n')
    if (key === this.sentFolders) return
    this.sentFolders = key
    this.options.send({ type: 'host:projects', paths })
  }

  private broadcast(event: HostEvent): void {
    this.hub.broadcast(event)
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

  connect(channel: PortChannel): string {
    return this.hub.add(channel)
  }

  private portClosed(portId: string): void {
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
    await this.agents.settingsChanged(previous, next)
  }

  busy(requestId: number): void {
    this.options.send({ type: 'host:busy', requestId, sessions: this.sessions.busy() })
  }

  /** Takes the paths main granted for attachments, then says so, before main answers the renderer. */
  grant(requestId: number, grants: AttachmentGrant[]): void {
    this.attachments.grant(grants)
    this.options.send({ type: 'host:granted', requestId })
  }

  /** `host:artifact-content-request`: the file of a version, for main's protocol. */
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

  /**
   * `host:artifact-import-request`: makes an artifact of a file the user chose, in `project` or,
   * when it is null, in a new scratch folder, which the page lists under No project.
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
          html: read.html,
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

  /** Stops every agent with the documented sequence, flushes the state files, then reports. */
  shutdown(): Promise<void> {
    this.stopping ??= (async () => {
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
        this.projects.flush(),
        this.sessions.flush(),
        this.remembered.flush(),
        this.updates.flush(),
        this.trees.close(),
        this.agentOptions.flush(),
        this.attachments.flush(),
        this.threads?.close(),
        this.usage.close(),
      ])
      this.hub.closeAll()
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

  /** A registered project or a scratch folder, canonical; git runs nowhere else. */
  private async gitProject(projectPath: string): Promise<string> {
    this.requireGit()
    const canonical = await this.projects.resolveDirectory(projectPath)
    if (!this.scratch.contains(canonical)) this.projects.match(canonical)
    return canonical
  }

  /**
   * Runs a file request for a registered project or a scratch folder, once the environment git
   * needs is resolved.
   */
  private async filesCall<T>(projectPath: string, run: (root: string) => Promise<T>): Promise<T> {
    const canonical = await this.projects.resolveDirectory(projectPath)
    if (!this.scratch.contains(canonical)) this.projects.match(canonical)
    await this.env.ready()
    return run(canonical)
  }

  private handlers(): Handlers {
    const { agents, sessions, projects, artifacts } = this
    return {
      'agents.list': () => agents.list(),
      'agents.check': ({ agentId }) => agents.check(agentId),
      'agents.reloadEnvironment': async () => {
        const result = await agents.reloadEnvironment()
        // A tool installed since the last probe shows up without a restart.
        if (this.git) await this.gitCall((g) => g.reloadTools())
        return result
      },
      'agents.environment': () => this.env.info(),
      'agents.authenticate': ({ agentId, methodId }) => agents.authenticate(agentId, methodId),
      'agents.logout': ({ agentId }) => agents.logout(agentId),
      'agents.retry': ({ agentId }) => agents.retry(agentId),
      'agents.reinstall': ({ agentId }) => agents.reinstall(agentId),
      'agents.checkUpdates': () => agents.checkUpdates(),
      'agents.update': ({ agentId }) => agents.update(agentId),
      'agents.install': ({ agentId, method }) => agents.install(agentId, method),
      'agents.cancelTask': ({ agentId }) => agents.cancelTask(agentId),
      'agents.start': async ({ agentId }) => {
        await agents.ensureReady(agentId)
        await agents.readOptions(agentId)
      },
      'agents.refreshLimits': ({ agentId }) => agents.refreshLimits(agentId),
      'agents.details': ({ agentId }) => agents.details(agentId),
      'agents.refreshAccount': ({ agentId }) => agents.refreshAccount(agentId),
      'agents.options': () => this.agentOptions.list(),
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
      'sessions.list': ({ projectPath }) => sessions.list(projectPath),
      'sessions.create': (params) => sessions.create(params),
      'sessions.import': (params) => sessions.importSession(params),
      'sessions.open': ({ sessionId }) => sessions.open(sessionId),
      'sessions.snapshot': ({ sessionId, from }) => sessions.snapshot(sessionId, from),
      'sessions.page': ({ sessionId, before }) => sessions.page(sessionId, before),
      'sessions.watch': ({ sessionId }, { portId }) => sessions.watch(sessionId, portId),
      'sessions.unwatch': ({ sessionId }, { portId }) => sessions.unwatch(sessionId, portId),
      'sessions.show': ({ sessionId }, { portId }) => sessions.show(sessionId, portId),
      'sessions.prompt': ({ sessionId, content }) => sessions.prompt(sessionId, content),
      'sessions.cancel': ({ sessionId }) => sessions.cancel(sessionId),
      'sessions.retry': ({ sessionId }) => sessions.retry(sessionId),
      'sessions.fork': ({ sessionId, entryId }) => sessions.fork(sessionId, entryId),
      'sessions.context': ({ sessionId }) => sessions.context(sessionId),
      'sessions.queue': ({ sessionId, content }) => sessions.queue(sessionId, content),
      'sessions.unqueue': ({ sessionId, itemId }) => sessions.unqueue(sessionId, itemId),
      'sessions.steer': ({ sessionId, itemId }) => sessions.steer(sessionId, itemId),
      'sessions.resumeQueue': ({ sessionId }) => sessions.resumeQueue(sessionId),
      'sessions.blob': ({ sessionId, hash }) => sessions.blob(sessionId, hash),
      'sessions.setConfigOption': ({ sessionId, optionId, value }) =>
        sessions.setConfigOption(sessionId, optionId, value),
      'sessions.rename': ({ sessionId, title }) => sessions.rename(sessionId, title),
      'sessions.close': ({ sessionId }) => sessions.close(sessionId),
      'sessions.delete': async ({ sessionId }) => {
        await sessions.delete(sessionId)
        this.options.send({ type: 'host:media-revoke', sessionId })
      },
      'sessions.removeEmpty': ({ keep }) => sessions.removeEmptyOnce(keep),
      'sessions.removeAll': async () => {
        await sessions.removeAll()
        this.options.send({ type: 'host:media-revoke', sessionId: null })
      },
      'permissions.respond': ({ sessionId, requestId, optionId }) =>
        sessions.respond(sessionId, requestId, optionId),
      'diagnostics.collect': () => this.collectDiagnostics(),
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
      'git.pullRequest': ({ url }) => this.gitCall((g) => g.pullRequest(url)),
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
      'files.list': ({ projectPath }) =>
        this.filesCall(projectPath, (root) => this.files.list(root)),
      'files.read': ({ projectPath, path }) =>
        this.filesCall(projectPath, (root) => this.files.read(root, path)),
      'files.search': ({ projectPath, query }) =>
        this.filesCall(projectPath, (root) => this.files.search(root, query)),
      'files.write': ({ projectPath, path, text, version }) =>
        this.filesCall(projectPath, (root) => this.files.write(root, path, text, version)),
      'media.open': async ({ projectPath, path, sessionId }) => {
        const root = await projects.resolveDirectory(projectPath)
        if (!this.scratch.contains(root)) projects.match(root)
        return this.media.open(root, path, sessionId)
      },
      'usage.summary': ({ dayStarts, from, to, scope }) =>
        this.usage.summary(dayStarts, from, to, scope),
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
        return { title: read.artifact.title, version: read.version.version, html: read.html }
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
      'artifacts.watch': ({ id }, { portId }) => artifacts.watch(id, portId),
      'artifacts.unwatch': ({ id }, { portId }) => artifacts.unwatch(id, portId),
    }
  }
}
