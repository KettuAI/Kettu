// Makes and prepares sessions' worktrees: the project's settings, the copy and the setup command.

import { withLongPaths, type ProjectWorktreeSettings, type WorktreeFailure } from '@shared/git'
import type { Platform } from '@shared/platform'
import { pathKey } from '../paths'
import type { WorktreeRecord } from '../storage'
import type { WorktreeGit, WorktreeInspection } from './api'

export const SETUP_TIMEOUT_MS = 10 * 60_000
const MAX_LOG = 256 * 1024
const TAIL_LINES = 12

export type PrepareState =
  { state: 'setup' } | { state: 'ready' } | { state: 'setup-failed'; failure: WorktreeFailure }

export interface WorktreeManagerDeps {
  git: WorktreeGit
  platform: Platform
  /** The project's stored worktree settings, with the defaults filled in. */
  settings(projectPath: string): ProjectWorktreeSettings
  /** The host's chosen folder for worktrees, or null for the folder beside each project. */
  root(): string | null
  /** The environment agents run with, resolved. */
  env(): Promise<NodeJS.ProcessEnv>
  takenByPullRequest?(projectPath: string, branch: string): boolean
  log(level: 'info' | 'warn' | 'error', message: string): void
  timeoutMs?: number
}

interface Preparation {
  abort: AbortController
  done: Promise<PrepareState>
}

/** The last lines of a command's output, for a failure note. */
export function lastLines(text: string, count = TAIL_LINES): string {
  return text.replace(/\s+$/, '').split(/\r?\n/).slice(-count).join('\n')
}

export class WorktreeManager {
  private readonly running = new Map<string, Preparation>()
  private readonly logs = new Map<string, string>()

  constructor(private readonly deps: WorktreeManagerDeps) {}

  settings(projectPath: string): ProjectWorktreeSettings {
    return this.deps.settings(projectPath)
  }

  /** Creates the branch and the worktree; rejects as the git side does, before any session. */
  create(
    projectPath: string,
    request: { base: string; branch?: string; text: string; type?: string; issue?: string },
  ): Promise<WorktreeRecord> {
    const { takenByPullRequest } = this.deps
    return this.deps.git.create({
      projectPath,
      root: this.deps.root(),
      base: request.base,
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      template: this.settings(projectPath).branchTemplate,
      text: request.text,
      ...(request.type === undefined ? {} : { type: request.type }),
      ...(request.issue === undefined ? {} : { issue: request.issue }),
      ...(takenByPullRequest
        ? { takenByPullRequest: (branch: string) => takenByPullRequest(projectPath, branch) }
        : {}),
    })
  }

  /**
   * Copies the project's local files, then runs its setup command, once per worktree at a time.
   * Never rejects: a failure is a state, with the stage and the end of the output.
   */
  prepare(
    projectPath: string,
    record: WorktreeRecord,
    onState: (state: PrepareState) => void,
  ): Promise<PrepareState> {
    const key = pathKey(record.path, this.deps.platform)
    const running = this.running.get(key)
    if (running) return running.done
    const abort = new AbortController()
    const done = this.run(projectPath, record, abort.signal, onState).finally(() => {
      if (this.running.get(key)?.abort === abort) this.running.delete(key)
    })
    this.running.set(key, { abort, done })
    return done
  }

  /** Ends a running preparation, which then reports itself failed. */
  stop(path: string): void {
    this.running.get(pathKey(path, this.deps.platform))?.abort.abort()
  }

  isPreparing(path: string): boolean {
    return this.running.has(pathKey(path, this.deps.platform))
  }

  /** What the setup command wrote last time it ran in this worktree. */
  setupLog(path: string): string {
    return this.logs.get(pathKey(path, this.deps.platform)) ?? ''
  }

  inspect(projectPath: string, record: WorktreeRecord): Promise<WorktreeInspection> {
    return this.deps.git.inspect(projectPath, record)
  }

  async remove(
    projectPath: string,
    record: WorktreeRecord,
    options: { branch: 'keep' | 'delete'; expected: WorktreeInspection },
  ): Promise<{ branchDeleted: boolean }> {
    this.stop(record.path)
    return this.deps.git.remove(projectPath, record, options)
  }

  /**
   * Makes the worktree again from its branch, with the project's local files copied in as at its
   * first start; the setup command is the user's to run again, since it may take long.
   */
  async recreate(projectPath: string, record: WorktreeRecord): Promise<void> {
    await this.deps.git.recreate(projectPath, record)
    const { copy } = this.settings(projectPath)
    try {
      await this.deps.git.copyLocalFiles(projectPath, record.path, copy)
    } catch (error) {
      this.deps.log('warn', `Worktree copy failed in ${record.path}: ${messageOf(error)}`)
    }
  }

  prune(projectPath: string): Promise<void> {
    return this.deps.git.prune(projectPath)
  }

  private async run(
    projectPath: string,
    record: WorktreeRecord,
    signal: AbortSignal,
    onState: (state: PrepareState) => void,
  ): Promise<PrepareState> {
    const key = pathKey(record.path, this.deps.platform)
    const settings = this.settings(projectPath)
    onState({ state: 'setup' })
    const fail = (failure: WorktreeFailure): PrepareState => {
      const state: PrepareState = { state: 'setup-failed', failure }
      onState(state)
      return state
    }
    try {
      const copy = await this.deps.git.copyLocalFiles(projectPath, record.path, settings.copy)
      for (const { path, reason } of copy.skipped) {
        this.deps.log('info', `Worktree copy skipped ${path}: ${reason}`)
      }
    } catch (error) {
      return fail({ stage: 'copy', exitCode: null, message: messageOf(error) })
    }
    if (settings.setup === null) {
      onState({ state: 'ready' })
      return { state: 'ready' }
    }
    this.logs.set(key, '')
    let env: NodeJS.ProcessEnv
    try {
      env = withLongPaths(await this.deps.env(), this.deps.platform)
    } catch (error) {
      return fail({ stage: 'setup', exitCode: null, message: messageOf(error) })
    }
    const run = await this.deps.git.runSetup(settings.setup, {
      cwd: record.path,
      projectPath,
      env,
      timeoutMs: this.deps.timeoutMs ?? SETUP_TIMEOUT_MS,
      signal,
      onOutput: (chunk) => {
        const log = (this.logs.get(key) ?? '') + chunk
        this.logs.set(key, log.length > MAX_LOG ? log.slice(-MAX_LOG) : log)
      },
    })
    if (run.exitCode === 0 && !run.timedOut) {
      onState({ state: 'ready' })
      return { state: 'ready' }
    }
    const reason = run.timedOut ? 'timed out' : signal.aborted ? 'stopped' : 'failed'
    this.deps.log('warn', `Worktree setup ${reason} in ${record.path} (${run.exitCode ?? '-'})`)
    return fail({
      stage: 'setup',
      exitCode: run.exitCode,
      message: lastLines(run.tail || this.setupLog(record.path)),
    })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
