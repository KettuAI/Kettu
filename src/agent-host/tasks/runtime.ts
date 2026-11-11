// The task engine's runtime on the host: its stage sessions, the task's worktree, the evidence
// of a round, the handover to a pull request, notifications and the workflows a task can run.

import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { harnessOf } from '@shared/agents'
import type { Platform } from '@shared/platform'
import type { PermissionScope } from '@shared/routines'
import type { TaskView } from '@shared/tasks'
import type { AgentId, ThreadEntry } from '@shared/thread'
import { HostError } from '../errors'
import type { GitServiceApi } from '../git/api'
import type { Exec } from '../git/exec'
import { t } from '../i18n'
import { askingMode } from '../routines/manager'
import type { WorktreeRecord } from '../storage'
import type { WorktreeManager } from '../worktrees/manager'
import type { TaskAgent, TaskEngineApi, TaskRuntime } from './api'
import { collectEvidence } from './evidence'
import type { TaskStageStart } from './hooks'
import { defaultBranchRef, listWorkflows, readWorkflow, type WorkflowSourceDeps } from './sources'

/** Only these harnesses ask Kettu before each call it does not allow, so Kettu holds the scope. */
const STAGE_HARNESSES: ReadonlySet<string> = new Set(['claude-code', 'codex'])

/** Agent states in which a stage may start it. */
const USABLE: ReadonlySet<AgentStatus['state']> = new Set([
  'available',
  'starting',
  'ready',
  'stopping',
  'failed',
])

const PULL_REQUEST_NOTE = 'Created by a Kettu task.'

export interface TaskRuntimeSessions {
  createStage(params: TaskStageStart): Promise<SessionSummary>
  prepareTaskWorktree(projectPath: string, worktree: WorktreeRecord): void
  sendFromTool(sessionId: string, text: string): Promise<'sent' | 'queued'>
  cancel(sessionId: string): Promise<void>
  has(sessionId: string): boolean
  turnsOf(sessionId: string): number
  threadEntries(sessionId: string): Promise<ThreadEntry[] | null>
  taskCostSince(sessionId: string, fromTurn: number): number
  workFolder(sessionId: string): string | null
}

export interface TaskRuntimeDeps {
  platform: Platform
  sessions: TaskRuntimeSessions
  agents: {
    statuses(): AgentStatus[]
    limitsOf(agentId: AgentId): TaskAgent['limits']
  }
  worktrees: WorktreeManager | null
  git(): GitServiceApi | null
  exec: Exec
  /** The user's own workflows, `<userData>/workflows`. */
  libraryDir: string
  /** A project folder, canonical; rejects when it is missing. */
  resolveProject(path: string): Promise<string>
  /** Sends a notification about the session; `kind` picks the switch in Settings that allows it. */
  attention(
    kind: 'permission' | 'turn-ended' | 'error',
    sessionId: string,
    title: string,
    body: string,
  ): void
  /** The engine, for the session a notification opens. */
  engine(): TaskEngineApi | null
  now?: () => number
}

/** The branch a pull request goes into, from the ref the worktree was cut from. */
export function baseBranch(ref: string): string {
  const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref)
  if (remote) return remote[1]!
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

export function createTaskRuntime(deps: TaskRuntimeDeps): TaskRuntime {
  const now = deps.now ?? Date.now
  const sources = (): WorkflowSourceDeps => ({ exec: deps.exec, libraryDir: deps.libraryDir })
  const git = (): GitServiceApi => {
    const service = deps.git()
    if (!service) throw new HostError('restricted', t('tasks.noGit'))
    return service
  }

  return {
    now,

    agents() {
      return deps.agents.statuses().flatMap((status): TaskAgent[] => {
        if (status.registered === false || status.uninstalled) return []
        return [
          {
            agentId: status.id,
            harness: status.harnessId,
            enabled: status.disabled !== true && USABLE.has(status.state),
            canRunStages: STAGE_HARNESSES.has(status.harnessId),
            limits: deps.agents.limitsOf(status.id),
          },
        ]
      })
    },

    async createWorktree(task, base) {
      const manager = deps.worktrees
      if (!manager) throw new HostError('restricted', t('tasks.noWorktrees'))
      const projectPath = await deps.resolveProject(task.projectPath)
      const from = base ?? (await defaultBranchRef(deps.exec, projectPath))
      if (from === null) throw new HostError('restricted', t('tasks.noDefaultBranch'))
      const worktree = await manager.create(projectPath, { base: from, text: task.title })
      deps.sessions.prepareTaskWorktree(projectPath, worktree)
      return worktree
    },

    async openSession(params) {
      const { task, run, agentId, scope } = params
      const summary = await deps.sessions.createStage({
        agentId,
        projectPath: task.projectPath,
        worktree: task.worktree,
        options: params.options,
        prompt: params.prompt,
        title: params.title,
        task: { taskId: task.id, runId: run.id, stageId: run.stageId, scope: scopeOf(scope) },
        // The default agent's table holds for every agent of its harness.
        mode: askingMode(harnessOf(agentId), scope.level),
      })
      const model = params.options.model
      return { sessionId: summary.id, model: typeof model === 'string' ? model : summary.model }
    },

    async send(sessionId, text) {
      await deps.sessions.sendFromTool(sessionId, text)
    },

    stop(sessionId) {
      return deps.sessions.cancel(sessionId)
    },

    alive(sessionId) {
      return deps.sessions.has(sessionId)
    },

    async evidence(sessionId, fromTurn) {
      const root = deps.sessions.workFolder(sessionId)
      if (root === null) return { commands: [], changedFiles: [], turns: 0 }
      const found = await collectEvidence(
        sessionId,
        fromTurn,
        (id) => deps.sessions.threadEntries(id),
        root,
        deps.platform,
      )
      return { ...found, costUsd: deps.sessions.taskCostSince(sessionId, fromTurn) }
    },

    turns(sessionId) {
      return deps.sessions.has(sessionId) ? deps.sessions.turnsOf(sessionId) : 0
    },

    costSince(sessionId, fromTurn) {
      return deps.sessions.taskCostSince(sessionId, fromTurn)
    },

    async handover(task, summary) {
      const worktree = task.worktree
      if (!worktree || worktree.removed !== undefined) {
        throw new HostError('restricted', t('tasks.noWorktree'))
      }
      const service = git()
      const status = await service.status(worktree.path)
      const target = status.push
      if (target?.kind !== 'remote') throw new HostError('restricted', t('tasks.noPushTarget'))
      await service.push(worktree.path, { remote: target.remote, branch: target.branch })
      const created = await service.createPullRequest(worktree.path, {
        title: task.title,
        body: `${summary.trim()}\n\n${PULL_REQUEST_NOTE}`,
        base: baseBranch(worktree.base),
        draft: false,
      })
      return created.url
    },

    notify(task, kind) {
      const sessionId = latestSession(deps.engine(), task)
      if (sessionId === null || !deps.sessions.has(sessionId)) return
      const body = noticeText(task, kind)
      if (kind === 'needs-you') deps.attention('permission', sessionId, task.title, body)
      else if (kind === 'done') deps.attention('turn-ended', sessionId, task.title, body)
      else deps.attention('error', sessionId, task.title, body)
    },

    async workflow(projectPath, source, id) {
      return readWorkflow(await deps.resolveProject(projectPath), source, id, sources())
    },

    async workflows(projectPath) {
      const resolved = projectPath === null ? null : await deps.resolveProject(projectPath)
      return listWorkflows(resolved, sources())
    },
  }
}

/** A plain copy, so the session record never shares the workflow's object. */
function scopeOf(scope: PermissionScope): PermissionScope {
  return { level: scope.level, web: scope.web }
}

/** The session of the task's latest stage run that had one, which a notification opens. */
function latestSession(engine: TaskEngineApi | null, task: TaskView): string | null {
  if (!engine) return null
  let runs
  try {
    runs = engine.get(task.id).runs
  } catch {
    return null
  }
  let latest: { sessionId: string; startedAt: number } | null = null
  for (const run of runs) {
    if (run.sessionId === null) continue
    if (!latest || run.startedAt >= latest.startedAt) {
      latest = { sessionId: run.sessionId, startedAt: run.startedAt }
    }
  }
  return latest?.sessionId ?? null
}

function noticeText(task: TaskView, kind: 'needs-you' | 'done' | 'blocked'): string {
  if (kind === 'done') return task.pullRequest ? t('tasks.doneWithPullRequest') : t('tasks.done')
  return task.reason ?? t(kind === 'needs-you' ? 'tasks.needsYou' : 'tasks.blocked')
}
