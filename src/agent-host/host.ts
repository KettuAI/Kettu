// The agent host, assembled: state, agents, sessions, git and the ports. index.ts runs it in
// the utility process; tests run it in-process with fakes for the launcher, shell and git.

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
import type { Env } from './find-command'
import type { GitServiceApi } from './git/api'
import { pathKey } from './paths'
import { Projects } from './projects'
import { PortHub, type Handlers, type PortChannel } from './rpc'
import { SessionManager, type SessionTimings } from './sessions'
import { EnvironmentService, type EnvironmentServiceDeps } from './shell-env'
import { projectsFile, sessionsFile } from './storage'
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
  /** The git service; null until it exists, and then every `git.*` request fails. */
  git?: GitServiceApi | null
  launcher?: AgentLauncher
  resolveEnv?: EnvironmentServiceDeps['resolve']
  probeNode?: EnvironmentServiceDeps['probe']
  detect?: AgentManagerDeps['detect']
  agentTimings?: Partial<AgentTimings>
  sessionTimings?: Partial<SessionTimings>
  mirrorTraffic?: boolean
}

const NO_GIT = 'Git is not available yet'

export class AgentHost {
  readonly diagnostics: Diagnostics
  readonly env: EnvironmentService
  readonly projects: Projects
  readonly agents: AgentManager
  readonly sessions: SessionManager
  readonly hub: PortHub
  private settings: HostSettings
  private readonly git: GitServiceApi | null
  private gitUnsubscribe: (() => void)[] = []
  /** Ports keeping a project's git status live, by path key. */
  private readonly gitRetains = new Map<string, { path: string; ports: Set<string> }>()
  private lastProcesses = '[]'
  private stopping: Promise<void> | null = null

  private constructor(private readonly options: HostOptions) {
    const { platform } = options
    this.settings = options.settings
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
    this.projects = new Projects({ file: projectsFile(options.userDataPath, log), platform })
    this.agents = new AgentManager({
      catalog: buildCatalog(options.fakeAgentPath),
      platform,
      electronPath: options.electronPath,
      appVersion: options.appVersion,
      env: this.env,
      diagnostics: this.diagnostics,
      launcher: options.launcher ?? processLauncher(platform),
      settings: () => this.settings,
      ...(options.detect ? { detect: options.detect } : {}),
      ...(options.agentTimings ? { timings: options.agentTimings } : {}),
      status: (status) => this.hub.broadcast({ type: 'agent.status', status }),
      processes: (processes) => this.reportProcesses(processes),
      authCommands: (commands) => options.send({ type: 'host:auth-commands', commands }),
    })
    this.sessions = new SessionManager({
      platform,
      agents: this.agents,
      projects: this.projects,
      file: sessionsFile(options.userDataPath, log),
      diagnostics: this.diagnostics,
      git: () => this.git,
      ...(options.sessionTimings ? { timings: options.sessionTimings } : {}),
      events: {
        patches: (batch, portIds) => this.hub.send(portIds, { type: 'session.patches', batch }),
        summary: (summary) => this.hub.broadcast({ type: 'session.summary', summary }),
        removed: (sessionId) => this.hub.broadcast({ type: 'session.removed', sessionId }),
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
      options.send({ type: 'host:projects', paths: projects.map((p) => p.path) })
    })
    this.env.onChange((info) => {
      this.broadcast({ type: 'environment.changed', info })
      this.git?.setEnvironment(this.env.agentEnv() as NodeJS.ProcessEnv)
    })
    this.git = options.git ?? null
    if (this.git) this.wireGit(this.git)
  }

  /** Loads the state, answers `host:ready`, and resolves the environment in the background. */
  static async start(options: HostOptions): Promise<AgentHost> {
    const host = new AgentHost(options)
    await Promise.all([host.projects.load(), host.sessions.load()])
    options.send({ type: 'host:projects', paths: host.projects.paths() })
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
      await Promise.all([this.projects.flush(), this.sessions.flush()])
      this.hub.closeAll()
      this.options.send({ type: 'host:stopped' })
    })()
    return this.stopping
  }

  collectDiagnostics(): DiagnosticsBundle {
    const node = this.env.nodeProbe()
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
      agents: this.agents.ids().map((agentId) => ({
        status: this.agents.status(agentId),
        capabilities: this.agents.rawCapabilities(agentId),
        ...this.diagnostics.agentRecords(agentId),
      })),
      sessions: this.sessions.list(),
      log: this.diagnostics.logEntries(),
    }
  }

  private requireGit(): GitServiceApi {
    if (!this.git) throw new HostError('git_error', NO_GIT)
    return this.git
  }

  private async gitCall<T>(run: (git: GitServiceApi) => Promise<T>): Promise<T> {
    const git = this.requireGit()
    try {
      return await run(git)
    } catch (error) {
      if (error instanceof HostError) throw error
      throw new HostError('git_error', (error as Error)?.message ?? String(error))
    }
  }

  private handlers(): Handlers {
    const { agents, sessions, projects } = this
    return {
      'agents.list': () => agents.list(),
      'agents.check': ({ agentId }) => agents.check(agentId),
      'agents.reloadEnvironment': () => agents.reloadEnvironment(),
      'agents.environment': () => this.env.info(),
      'agents.authenticate': ({ agentId, methodId }) => agents.authenticate(agentId, methodId),
      'agents.logout': ({ agentId }) => agents.logout(agentId),
      'agents.retry': ({ agentId }) => agents.retry(agentId),
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
      'sessions.prompt': ({ sessionId, content }) => sessions.prompt(sessionId, content),
      'sessions.cancel': ({ sessionId }) => sessions.cancel(sessionId),
      'sessions.retry': ({ sessionId }) => sessions.retry(sessionId),
      'sessions.setConfigOption': ({ sessionId, optionId, value }) =>
        sessions.setConfigOption(sessionId, optionId, value),
      'sessions.close': ({ sessionId }) => sessions.close(sessionId),
      'sessions.delete': ({ sessionId }) => sessions.delete(sessionId),
      'sessions.removeAll': () => sessions.removeAll(),
      'permissions.respond': ({ sessionId, requestId, optionId }) =>
        sessions.respond(sessionId, requestId, optionId),
      'diagnostics.collect': () => this.collectDiagnostics(),
      'git.status': async ({ projectPath }, { portId }) => {
        const git = this.requireGit()
        const canonical = await projects.resolveDirectory(projectPath)
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
    }
  }
}
