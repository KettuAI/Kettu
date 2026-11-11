// The task engine's runtime on the host: its node sessions, the worktrees of a task and of its
// branches with the merges between them, notifications and the SOPs a task can start with.

import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { harnessOf } from '@shared/agents'
import type { PermissionScope } from '@shared/routines'
import type { TaskView } from '@shared/tasks'
import { HostError } from '../errors'
import { describeFailure, GIT_TIMEOUT_MS, type Exec, type ExecResult } from '../git/exec'
import { t } from '../i18n'
import { askingMode } from '../routines/manager'
import type { LogFn, WorktreeRecord } from '../storage'
import type { WorktreeManager } from '../worktrees/manager'
import { checkWorktreeBranch, MAX_SLUG_LENGTH, slugOf } from '../worktrees/names'
import type { SopLibraryApi, TaskAgent, TaskEngineApi, TaskRuntime } from './api'
import type { TaskNodeStart } from './hooks'

/** Only these harnesses ask Kettu before each call it does not allow, so Kettu holds the scope. */
const NODE_HARNESSES: ReadonlySet<string> = new Set(['claude-code', 'codex'])

/** Agent states in which a node may start it. */
const USABLE: ReadonlySet<AgentStatus['state']> = new Set([
  'available',
  'starting',
  'ready',
  'stopping',
  'failed',
])

/**
 * What every node session may do without asking: work inside its worktree, commands included.
 * Whatever leaves the worktree waits for the person.
 */
export const NODE_SCOPE: PermissionScope = { level: 'commands', web: false }

/** Merging a branch of a large repository takes a while. */
export const MERGE_TIMEOUT_MS = 120_000
const OUTPUT_LINES = 12

export interface TaskRuntimeSessions {
  createNode(params: TaskNodeStart): Promise<SessionSummary>
  prepareTaskWorktree(projectPath: string, worktree: WorktreeRecord): void
  sendFromTool(sessionId: string, text: string): Promise<'sent' | 'queued'>
  cancel(sessionId: string): Promise<void>
  has(sessionId: string): boolean
  isWorking(sessionId: string): boolean
  /** Stops the agents of the sessions in a worktree; the sessions stay. */
  closeWorktreeUsers(path: string): Promise<void>
  /** A worktree was removed, with or without its branch: its sessions say so. */
  worktreeRemoved(path: string, branchDeleted: boolean): void
}

export interface TaskRuntimeDeps {
  sessions: TaskRuntimeSessions
  agents: { statuses(): AgentStatus[] }
  worktrees: WorktreeManager | null
  exec: Exec
  library: Pick<SopLibraryApi, 'read'>
  /** A project folder, canonical; rejects when it is missing. */
  resolveProject(path: string): Promise<string>
  /** Sends a notification about the session; `kind` picks the switch in Settings that allows it. */
  attention(kind: 'permission' | 'turn-ended', sessionId: string, title: string, body: string): void
  /** The engine, for the session a notification opens. */
  engine(): TaskEngineApi | null
  log: LogFn
  now?: () => number
}

function ok(result: ExecResult): boolean {
  return result.failure === null && result.code === 0
}

/** What git wrote last, for an error the person reads: a merge reports on stdout. */
function gitOutput(result: ExecResult): string {
  const text = [result.stderr, result.stdout]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n')
  return text === '' ? describeFailure(result) : text.split(/\r?\n/).slice(-OUTPUT_LINES).join('\n')
}

function gitError(label: string, result: ExecResult): HostError {
  const detail = result.failure === null ? gitOutput(result) : describeFailure(result)
  return new HostError('git_error', `${label}: ${detail}`)
}

/** The branch by its full ref name, which git reads neither as an option nor as another ref. */
function branchRef(worktree: WorktreeRecord): string {
  return `refs/heads/${checkWorktreeBranch(worktree.branch)}`
}

/** The words a branch's worktree is named from: the task's title, cut so the label still fits. */
export function forkName(title: string, label: string): string {
  const tail = slugOf(label)
  const head = slugOf(title)
  if (tail === '') return head.replaceAll('-', ' ')
  const kept: string[] = []
  let length = tail.length
  for (const word of head === '' ? [] : head.split('-')) {
    if (length + 1 + word.length > MAX_SLUG_LENGTH) break
    kept.push(word)
    length += 1 + word.length
  }
  return [...kept, ...tail.split('-')].join(' ')
}

export function createTaskRuntime(deps: TaskRuntimeDeps): TaskRuntime {
  const now = deps.now ?? Date.now
  const git = (cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS) =>
    deps.exec('git', args, { cwd, timeoutMs })

  /** Whether `rev` names a commit; rejects when git could not say. */
  async function isCommit(cwd: string, rev: string): Promise<boolean> {
    const result = await git(cwd, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${rev}^{commit}`,
    ])
    if (result.failure === null && result.code === 1) return false
    if (!ok(result)) throw gitError('git rev-parse', result)
    return true
  }

  /**
   * The ref a task's worktree is cut from: the project's default branch, else the branch checked
   * out. Null when the folder is no git repository, or one without a commit to cut from.
   */
  async function baseRef(projectPath: string): Promise<string | null> {
    const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree'])
    if (inside.failure === 'not-found') return null
    if (inside.failure !== null) throw gitError('git rev-parse', inside)
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
    const fallback = await defaultBranchRef(deps.exec, projectPath)
    if (fallback !== null) return fallback
    const head = await git(projectPath, ['symbolic-ref', '--quiet', 'HEAD'])
    const current = ok(head) ? head.stdout.trim() : ''
    if (current.startsWith('refs/heads/') && (await isCommit(projectPath, current))) return current
    if (!(await isCommit(projectPath, 'HEAD'))) return null
    throw new HostError('restricted', t('tasks.noDefaultBranch'))
  }

  async function mergeUnderWay(cwd: string): Promise<boolean> {
    return isCommit(cwd, 'MERGE_HEAD')
  }

  async function hasConflicts(cwd: string): Promise<boolean> {
    const result = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'])
    if (!ok(result)) throw gitError('git diff', result)
    return result.stdout !== ''
  }

  async function abortMerge(cwd: string): Promise<void> {
    const result = await git(cwd, ['merge', '--abort'], MERGE_TIMEOUT_MS)
    if (!ok(result)) throw gitError('git merge --abort', result)
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
            canRunNodes: NODE_HARNESSES.has(status.harnessId),
          },
        ]
      })
    },

    async createWorktree(task) {
      const manager = deps.worktrees
      if (!manager) return null
      const projectPath = await deps.resolveProject(task.projectPath)
      const base = await baseRef(projectPath)
      if (base === null) return null
      const worktree = await manager.create(projectPath, { base, text: task.title })
      deps.sessions.prepareTaskWorktree(projectPath, worktree)
      return worktree
    },

    async forkWorktree(task, from, label) {
      const manager = deps.worktrees
      if (!manager) throw new HostError('restricted', t('tasks.noWorktrees'))
      const projectPath = await deps.resolveProject(task.projectPath)
      const worktree = await manager.create(projectPath, {
        base: branchRef(from),
        text: forkName(task.title, label),
      })
      deps.sessions.prepareTaskWorktree(projectPath, worktree)
      return worktree
    },

    async clean(worktree) {
      const status = await git(worktree.path, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal',
      ])
      if (!ok(status)) throw gitError('git status', status)
      return status.stdout === '' && !(await mergeUnderWay(worktree.path))
    },

    async merge(into, from, leave) {
      const branch = branchRef(from)
      // A merge already under way is not this one's to stop or to count as its own.
      if (await mergeUnderWay(into.path)) {
        throw new HostError('conflict', t('tasks.mergeUnderWay', { branch: into.branch }))
      }
      const result = await git(into.path, ['merge', '--no-edit', branch], MERGE_TIMEOUT_MS)
      if (ok(result)) return 'merged'
      if (result.failure !== null) throw gitError('git merge', result)
      // No merge under way: git refused to start, as over uncommitted changes it would overwrite.
      if (!(await mergeUnderWay(into.path))) throw gitError('git merge', result)
      const conflicts = await hasConflicts(into.path)
      if (conflicts && leave) return 'conflict'
      await abortMerge(into.path)
      if (conflicts) return 'conflict'
      // It stopped for another reason, such as a hook that refused the merge commit.
      throw gitError('git merge', result)
    },

    async merged(into, from) {
      const result = await git(into.path, ['merge-base', '--is-ancestor', branchRef(from), 'HEAD'])
      if (result.failure === null && result.code === 1) return false
      if (!ok(result)) throw gitError('git merge-base', result)
      return true
    },

    async removeWorktree(task, worktree, merged) {
      const manager = deps.worktrees
      // The task's own worktree holds its result and is never one to clear away.
      if (!manager || worktree.path === task.worktree?.path) return
      try {
        const projectPath = await deps.resolveProject(task.projectPath)
        await deps.sessions.closeWorktreeUsers(worktree.path)
        const state = await manager.inspect(projectPath, worktree)
        // Nothing uncommitted is thrown away: such a worktree stays for the person.
        if (state.uncommitted > 0) {
          deps.log('info', `Kept the worktree ${worktree.path}: it has uncommitted changes`)
          return
        }
        // The branch goes only when its commits are on another branch still.
        const safe =
          merged && state.head !== null && (await heldElsewhere(projectPath, worktree, state.head))
        const result = await manager.remove(projectPath, worktree, {
          branch: safe ? 'delete' : 'keep',
          expected: safe ? { ...state, merged: true } : state,
        })
        deps.sessions.worktreeRemoved(worktree.path, result.branchDeleted)
      } catch (error) {
        deps.log(
          'warn',
          `Could not remove the worktree ${worktree.path}: ${(error as Error).message}`,
        )
      }
    },

    async openSession(params) {
      const { task, run, agentId } = params
      const summary = await deps.sessions.createNode({
        agentId,
        projectPath: task.projectPath,
        worktree: params.worktree,
        options: params.options,
        prompt: params.prompt,
        title: params.title,
        task: { taskId: task.id, runId: run.id, nodeId: run.nodeId, scope: { ...NODE_SCOPE } },
        // The default agent's table holds for every agent of its harness.
        mode: askingMode(harnessOf(agentId), NODE_SCOPE.level),
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

    working(sessionId) {
      return deps.sessions.isWorking(sessionId)
    },

    notify(task, kind) {
      const notice = noticeOf(deps.engine(), task, kind)
      if (notice.sessionId === null || !deps.sessions.has(notice.sessionId)) return
      deps.attention(
        kind === 'needs-you' ? 'permission' : 'turn-ended',
        notice.sessionId,
        task.title,
        notice.body,
      )
    },

    sop(source, id) {
      return deps.library.read(source, id)
    },
  }

  /** Whether a local branch other than the worktree's own holds the commit. */
  async function heldElsewhere(
    projectPath: string,
    worktree: WorktreeRecord,
    head: string,
  ): Promise<boolean> {
    const result = await git(projectPath, [
      'for-each-ref',
      '--format=%(refname)',
      '--contains',
      head,
      'refs/heads/',
    ])
    if (!ok(result)) throw gitError('git for-each-ref', result)
    const own = `refs/heads/${worktree.branch}`
    return result.stdout.split('\n').some((ref) => ref !== '' && ref !== own)
  }
}

/**
 * The full name of the project's default branch: the remote's HEAD, else `main` or `master` on
 * the remote and then locally. Null outside a git repository or when none exists.
 */
export async function defaultBranchRef(exec: Exec, projectPath: string): Promise<string | null> {
  const candidates = [
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'refs/heads/main',
    'refs/heads/master',
  ]
  const result = await exec(
    'git',
    ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/remotes/origin/HEAD', ...candidates],
    { cwd: projectPath, timeoutMs: GIT_TIMEOUT_MS },
  )
  if (result.failure !== null || result.code !== 0) return null
  const refs = new Set<string>()
  let remoteHead: string | null = null
  for (const line of result.stdout.split('\n')) {
    const [refname, symref] = line.split('\0')
    if (!refname) continue
    refs.add(refname)
    if (refname === 'refs/remotes/origin/HEAD' && symref) remoteHead = symref
  }
  if (remoteHead !== null) {
    const there = await exec('git', ['rev-parse', '--verify', '--quiet', remoteHead], {
      cwd: projectPath,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (there.failure === null && there.code === 0) return remoteHead
  }
  return candidates.find((ref) => refs.has(ref)) ?? null
}

/**
 * What a notification says and the session it opens: the run that waits for the person, else
 * the task's latest run that had a session.
 */
function noticeOf(
  engine: TaskEngineApi | null,
  task: TaskView,
  kind: 'needs-you' | 'done',
): { sessionId: string | null; body: string } {
  const fallback = kind === 'needs-you' ? t('tasks.needsYou') : endText(task)
  if (!engine) return { sessionId: null, body: fallback }
  let runs
  try {
    runs = engine.get(task.id).runs
  } catch {
    return { sessionId: null, body: fallback }
  }
  const latest = (list: typeof runs) =>
    list.reduce<(typeof runs)[number] | null>(
      (found, run) => (!found || run.startedAt >= found.startedAt ? run : found),
      null,
    )
  const withSession = latest(runs.filter((run) => run.sessionId !== null))
  if (kind === 'done') return { sessionId: withSession?.sessionId ?? null, body: fallback }
  const waiting = latest(runs.filter((run) => run.state === 'waiting'))
  return {
    sessionId: waiting?.sessionId ?? withSession?.sessionId ?? null,
    body: waiting?.reason ?? fallback,
  }
}

function endText(task: TaskView): string {
  return t(task.state === 'dropped' ? 'tasks.dropped' : 'tasks.done')
}
