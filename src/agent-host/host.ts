// The agent host, assembled: state, agents, sessions, git and the ports. index.ts runs it in
// the utility process; tests run it in-process with fakes for the launcher, shell and git.

import path from 'node:path'
import type { DiagnosticsBundle, HostEvent } from '@shared/agent-host'
import type { HostToMain } from '@shared/host-control'
import type { Platform } from '@shared/platform'
import type { HostSettings } from '@shared/settings'
import type { AgentId } from '@shared/thread'
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
import type { Env } from './find-command'
import type { GitServiceApi, GitServiceDeps } from './git/api'
import { createExec, type ExecRunner } from './git/exec'
import { pathKey } from './paths'
import { Projects } from './projects'
import { PortHub, type Handlers, type PortChannel } from './rpc'
import { ScratchFolders } from './scratch'
import { SessionManager, type SessionTimings } from './sessions'
import { EnvironmentService, type EnvironmentServiceDeps } from './shell-env'
import { agentsFile, projectsFile, sessionsFile, type AgentsFile, type JsonFile } from './storage'
import { ThreadStore, type ThreadWorkerFactory } from './threads/store'
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
  mirrorTraffic?: boolean
  /** Starts the worker that owns the thread database; without it no thread is stored. */
  threadWorker?: ThreadWorkerFactory
}

export class AgentHost {
  readonly diagnostics: Diagnostics
  readonly env: EnvironmentService
  readonly projects: Projects
  readonly scratch: ScratchFolders
  readonly agents: AgentManager
  /** What the agents last reported about their accounts and plans, kept across runs. */
  private readonly remembered: JsonFile<AgentsFile>
  readonly sessions: SessionManager
  /** Every session's thread, read a page at a time, in a worker of its own. */
  readonly threads: ThreadStore | null
  readonly hub: PortHub
  private settings: HostSettings
  private readonly git: GitServiceApi | null
  /** Runs git for the project's files, with the agent environment. */
  private readonly execRunner: ExecRunner
  private readonly files: FilesService
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
    this.projects = new Projects({ file: projectsFile(options.userDataPath, log), platform })
    this.scratch = new ScratchFolders(path.join(options.userDataPath, 'scratch'), platform)
    this.remembered = agentsFile(options.userDataPath, log)
    this.threads = options.threadWorker
      ? new ThreadStore({
          file: path.join(options.userDataPath, 'state', 'threads.db'),
          createWorker: options.threadWorker,
          log,
        })
      : null
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
      authCommands: (commands) => options.send({ type: 'host:auth-commands', commands }),
      remember: (file) => this.remembered.save(file),
    })
    this.sessions = new SessionManager({
      platform,
      agents: this.agents,
      projects: this.projects,
      scratch: this.scratch,
      file: sessionsFile(options.userDataPath, log),
      diagnostics: this.diagnostics,
      git: () => this.git,
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
    const [, , , remembered] = await Promise.all([
      host.scratch.ready(),
      host.projects.load(),
      host.sessions.load(),
      host.remembered.load(),
    ])
    host.agents.restore(remembered)
    host.sendFolders()
    options.send({ type: 'host:ready' })
    void host.agents.detectAll()
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

  private reportProcesses(processes: { agentId: AgentId; pid: number }[]): void {
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
    await this.agents.settingsChanged(previous, next)
  }

  busy(requestId: number): void {
    this.options.send({ type: 'host:busy', requestId, sessions: this.sessions.busy() })
  }

  /** Stops every agent with the documented sequence, flushes the state files, then reports. */
  shutdown(): Promise<void> {
    this.stopping ??= (async () => {
      this.sessions.shutdown()
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
        this.projects.flush(),
        this.sessions.flush(),
        this.remembered.flush(),
        this.threads?.close(),
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
    const { agents, sessions, projects } = this
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
      'agents.start': async ({ agentId }) => {
        await agents.ensureReady(agentId)
      },
      'agents.refreshLimits': ({ agentId }) => agents.refreshLimits(agentId),
      'agents.details': ({ agentId }) => agents.details(agentId),
      'agents.refreshAccount': ({ agentId }) => agents.refreshAccount(agentId),
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
      },
      'projects.touch': ({ path }) => projects.touch(projects.match(path)),
      'sessions.list': ({ projectPath }) => sessions.list(projectPath),
      'sessions.create': (params) => sessions.create(params),
      'sessions.import': (params) => sessions.importSession(params),
      'sessions.open': ({ sessionId }) => sessions.open(sessionId),
      'sessions.snapshot': ({ sessionId }) => sessions.snapshot(sessionId),
      'sessions.watch': ({ sessionId }, { portId }) => sessions.watch(sessionId, portId),
      'sessions.unwatch': ({ sessionId }, { portId }) => sessions.unwatch(sessionId, portId),
      'sessions.show': ({ sessionId }, { portId }) => sessions.show(sessionId, portId),
      'sessions.prompt': ({ sessionId, content }) => sessions.prompt(sessionId, content),
      'sessions.cancel': ({ sessionId }) => sessions.cancel(sessionId),
      'sessions.retry': ({ sessionId }) => sessions.retry(sessionId),
      'sessions.fork': ({ sessionId }) => sessions.fork(sessionId),
      'sessions.context': ({ sessionId }) => sessions.context(sessionId),
      'sessions.queue': ({ sessionId, content }) => sessions.queue(sessionId, content),
      'sessions.unqueue': ({ sessionId, itemId }) => sessions.unqueue(sessionId, itemId),
      'sessions.steer': ({ sessionId, itemId }) => sessions.steer(sessionId, itemId),
      'sessions.resumeQueue': ({ sessionId }) => sessions.resumeQueue(sessionId),
      'sessions.setConfigOption': ({ sessionId, optionId, value }) =>
        sessions.setConfigOption(sessionId, optionId, value),
      'sessions.rename': ({ sessionId, title }) => sessions.rename(sessionId, title),
      'sessions.close': ({ sessionId }) => sessions.close(sessionId),
      'sessions.delete': ({ sessionId }) => sessions.delete(sessionId),
      'sessions.removeAll': () => sessions.removeAll(),
      'permissions.respond': ({ sessionId, requestId, optionId }) =>
        sessions.respond(sessionId, requestId, optionId),
      'diagnostics.collect': () => this.collectDiagnostics(),
      'git.status': async ({ projectPath }, { portId }) => {
        const git = this.requireGit()
        const canonical = await projects.resolveDirectory(projectPath)
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
      'git.fetch': async ({ projectPath }) => {
        this.requireGit()
        const canonical = await projects.resolveDirectory(projectPath)
        return this.gitCall((g) => g.fetch(canonical))
      },
      'git.pullRequest': ({ url }) => this.gitCall((g) => g.pullRequest(url)),
      'git.currentPullRequest': async ({ projectPath }) => {
        this.requireGit()
        const canonical = await projects.resolveDirectory(projectPath)
        return this.gitCall((g) => g.currentPullRequest(canonical))
      },
      'git.tools': () => this.gitCall((g) => g.tools()),
      'files.list': ({ projectPath }) =>
        this.filesCall(projectPath, (root) => this.files.list(root)),
      'files.read': ({ projectPath, path }) =>
        this.filesCall(projectPath, (root) => this.files.read(root, path)),
      'files.search': ({ projectPath, query }) =>
        this.filesCall(projectPath, (root) => this.files.search(root, query)),
    }
  }
}
