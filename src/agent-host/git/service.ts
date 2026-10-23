// The git service: repository status, pull requests and git events for the agent host.

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import {
  GITHUB_PULL_REQUEST_URL,
  type GitOperation,
  type GitStatus,
  type GitTools,
  type PullRequest,
  type PushTarget,
} from '@shared/git'
import type { ToolKind } from '@shared/thread'
import type { BranchPullRequest, GitEventDraft, GitServiceApi, GitServiceDeps } from './api'
import { HostError } from '../errors'
import { t } from '../i18n'
import { createCoalescer } from './coalesce'
import { readChanges, readCommitDetails, readFileDiff, readIncoming } from './details'
import { canChangeRepository, computeGitEvents, listNewCommits } from './events'
import { CommandError, createExec, describeFailure, FETCH_TIMEOUT_MS, type Exec } from './exec'
import {
  listBranchPullRequests,
  probeTools,
  viewCurrentPullRequest,
  viewPullRequestByUrl,
} from './gh'
import { nextPollDelayMs } from './github'
import {
  createdPullRequest,
  createPullRequest,
  logOf,
  publishRepository,
  pull,
  push,
} from './operations'
import { createRepoCache, emptyStatus, readStatus, type RepoCache } from './status'
import { watchGitDir, type GitDirWatch, type WatchFn } from './watch'

export interface GitServiceOptions {
  /** Replaces the process runner. */
  exec?: Exec
  watch?: WatchFn
  debounceMs?: number
  now?: () => number
}

const PULL_REQUEST_MIN_INTERVAL_MS = 60_000
const PULL_REQUEST_CACHE_MS = 60_000
const PULL_REQUEST_CACHE_SIZE = 200
const BACKGROUND_FETCH_INTERVAL_MS = 5 * 60_000
// A tool call that never ended, such as one of a crashed agent, stops blocking attribution.
const STALE_CALL_MS = 30 * 60_000
const EMPTY_BRANCH_PULL_REQUESTS: ReadonlyMap<string, BranchPullRequest> = new Map()

/** The key a project is stored under: absolute, normalized, and case-folded on Windows. */
export function projectKey(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = platform === 'win32' ? win32 : posix
  if (!path.isAbsolute(projectPath))
    throw new Error(`Project path must be absolute: ${projectPath}`)
  const resolved = path.resolve(projectPath)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

interface Snapshot {
  status: GitStatus
  /** Orders snapshots of one project; a larger number is a later refresh. */
  seq: number
}

interface ToolCall {
  sessionId: string
  startedAt: number
  before: Snapshot | null
  /** Another session had a tool call running at some point in the interval. */
  contested: boolean
}

interface ProjectState {
  projectPath: string
  cache: RepoCache
  status: GitStatus | null
  seq: number
  refresher: { request(): Promise<Snapshot> }
  retainers: Set<string>
  watcher: GitDirWatch | null
  watcherGitDir: string | null
  watcherStarting: boolean
  fetching: Promise<GitOperation> | null
  /** The pull, push or publish that is running; one at a time. */
  operation: Promise<unknown> | null
  calls: Map<string, ToolCall>
  /** The last snapshot that tool call comparisons have already accounted for. */
  baseline: Snapshot | null
  reportedPullRequests: Set<string>
  /** The current branch's pull request; null while unknown. */
  pullRequest: { branch: string | null; value: PullRequest | null } | null
  announcedPullRequest: PullRequest | null
  branchPullRequests: ReadonlyMap<string, BranchPullRequest>
  poller: { request(): Promise<void> }
  lastPollAt: number
  pollTimer: ReturnType<typeof setTimeout> | null
  logged: Map<string, string>
}

function createEmitter<A extends unknown[]>(onError: (error: unknown) => void) {
  const listeners = new Set<(...args: A) => void>()
  return {
    on(listener: (...args: A) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(...args: A): void {
      for (const listener of [...listeners]) {
        try {
          listener(...args)
        } catch (error) {
          onError(error)
        }
      }
    },
  }
}

function sameStatus(a: GitStatus, b: GitStatus): boolean {
  return JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 })
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createGitService(
  deps: GitServiceDeps,
  options: GitServiceOptions = {},
): GitServiceApi {
  let env = deps.env
  const now = options.now ?? Date.now
  const runner = options.exec ? { exec: options.exec, killAll() {} } : createExec(() => env)
  const exec = runner.exec
  const log = deps.log
  const reportListenerError = (error: unknown): void =>
    log('error', `A git service listener threw: ${messageOf(error)}`)

  const projects = new Map<string, ProjectState>()
  const pending = new Set<Promise<unknown>>()
  const pullRequestCache = new Map<string, { at: number; value: PullRequest }>()
  const pullRequestLoads = new Map<string, Promise<PullRequest>>()
  let disposed = false
  let backgroundFetch: ReturnType<typeof setInterval> | null = null
  let backgroundFetching = false
  let toolsPromise: Promise<GitTools> | null = null
  let currentTools: GitTools | null = null

  const changed = createEmitter<[GitStatus]>(reportListenerError)
  const pullRequestChanged = createEmitter<[string, PullRequest | null]>(reportListenerError)
  const branchPullRequestsChanged = createEmitter<[string]>(reportListenerError)
  const sessionEvents = createEmitter<[string, GitEventDraft[]]>(reportListenerError)
  const toolsChanged = createEmitter<[GitTools]>(reportListenerError)

  // Fire-and-forget work must never leave a rejection unhandled in the host.
  function background(promise: Promise<unknown>): void {
    promise.catch((error: unknown) =>
      log('error', `Background git work failed: ${messageOf(error)}`),
    )
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    const done = promise.then(
      () => undefined,
      () => undefined,
    )
    pending.add(done)
    void done.then(() => pending.delete(done))
    return promise
  }

  // Logs a message once per change, so a persistent failure does not fill the log.
  function logChange(
    state: ProjectState,
    key: string,
    level: 'info' | 'warn' | 'error',
    message: string | null,
  ): void {
    if (message === null) {
      state.logged.delete(key)
      return
    }
    if (state.logged.get(key) === message) return
    state.logged.set(key, message)
    log(level, `${state.projectPath}: ${message}`)
  }

  function lookup(projectPath: string): ProjectState | undefined {
    try {
      return projects.get(projectKey(projectPath))
    } catch {
      return undefined
    }
  }

  function projectFor(projectPath: string): ProjectState {
    if (disposed) throw new Error('The git service is disposed')
    const key = projectKey(projectPath)
    let state = projects.get(key)
    if (!state) {
      const created: ProjectState = {
        projectPath,
        cache: createRepoCache(),
        status: null,
        seq: 0,
        refresher: createCoalescer(() => track(runRefresh(created))),
        retainers: new Set(),
        watcher: null,
        watcherGitDir: null,
        watcherStarting: false,
        fetching: null,
        operation: null,
        calls: new Map(),
        baseline: null,
        reportedPullRequests: new Set(),
        pullRequest: null,
        announcedPullRequest: null,
        branchPullRequests: EMPTY_BRANCH_PULL_REQUESTS,
        poller: createCoalescer(() => track(runPoll(created))),
        lastPollAt: 0,
        pollTimer: null,
        logged: new Map(),
      }
      projects.set(key, created)
      state = created
    }
    return state
  }

  const isLive = (state: ProjectState): boolean => !disposed && state.retainers.size > 0

  // Tools

  function getTools(): Promise<GitTools> {
    toolsPromise ??= probeTools(exec, homedir()).then((tools) => {
      currentTools = tools
      return tools
    })
    return toolsPromise
  }

  function setTools(tools: GitTools): void {
    const differs = currentTools === null || !sameJson(currentTools, tools)
    currentTools = tools
    toolsPromise = Promise.resolve(tools)
    if (differs) toolsChanged.emit(tools)
  }

  function markGitMissing(): void {
    if (currentTools && currentTools.git.found) {
      setTools({ ...currentTools, git: { found: false, version: null } })
    }
  }

  // Status

  function snapshotOf(state: ProjectState): Snapshot | null {
    return state.status ? { status: state.status, seq: state.seq } : null
  }

  async function runRefresh(state: ProjectState): Promise<Snapshot> {
    let next: GitStatus
    try {
      next = await readStatus({ projectPath: state.projectPath, exec, cache: state.cache, now })
      logChange(state, 'status', 'warn', null)
    } catch (error) {
      if (disposed)
        return snapshotOf(state) ?? { status: emptyStatus(state.projectPath, now()), seq: 0 }
      next = failedStatus(state, error)
    }
    return commitStatus(state, next)
  }

  function failedStatus(state: ProjectState, error: unknown): GitStatus {
    const missing = error instanceof CommandError && error.result.failure === 'not-found'
    if (missing) markGitMissing()
    logChange(state, 'status', 'warn', `Could not read the git status: ${messageOf(error)}`)
    if (state.status) return { ...state.status, stale: true, updatedAt: now() }
    return { ...emptyStatus(state.projectPath, now()), stale: !missing }
  }

  function commitStatus(state: ProjectState, next: GitStatus): Snapshot {
    const previous = state.status
    state.status = next
    state.seq += 1
    const snapshot = { status: next, seq: state.seq }
    if (previous === null || !sameStatus(previous, next)) changed.emit(next)
    if (isLive(state)) {
      ensureWatcher(state, next)
      triggerPullRequests(state, previous, next)
    }
    return snapshot
  }

  function requestRefresh(state: ProjectState): Promise<Snapshot> {
    return state.refresher.request()
  }

  function refreshInBackground(state: ProjectState): void {
    background(requestRefresh(state))
  }

  // Watching

  function ensureWatcher(state: ProjectState, status: GitStatus): void {
    if (!status.repo) {
      closeWatcher(state)
      return
    }
    const gitDir = status.repo.gitDir
    if (state.watcher?.alive && state.watcherGitDir === gitDir) return
    if (state.watcherStarting) return
    closeWatcher(state)
    state.watcherStarting = true
    const commonDir = state.cache.repo?.commonDir ?? gitDir
    void watchGitDir({
      gitDir,
      commonDir,
      debounceMs: options.debounceMs,
      watch: options.watch,
      onChange: () => refreshInBackground(state),
      onError: (error) =>
        logChange(state, 'watch', 'warn', `Watching the git dir failed: ${error.message}`),
    })
      .then((watcher) => {
        if (isLive(state)) {
          state.watcher = watcher
          state.watcherGitDir = gitDir
        } else {
          watcher.close()
        }
      })
      .catch((error: unknown) =>
        logChange(state, 'watch', 'warn', `Could not watch the git dir: ${messageOf(error)}`),
      )
      .finally(() => {
        state.watcherStarting = false
      })
  }

  function closeWatcher(state: ProjectState): void {
    state.watcher?.close()
    state.watcher = null
    state.watcherGitDir = null
  }

  function goLive(state: ProjectState): void {
    if (state.status?.repo) ensureWatcher(state, state.status)
    background(requestRefresh(state).then(() => requestPoll(state, false)))
  }

  function stopLive(state: ProjectState): void {
    closeWatcher(state)
    if (state.pollTimer !== null) clearTimeout(state.pollTimer)
    state.pollTimer = null
  }

  // Pull requests

  function triggerPullRequests(
    state: ProjectState,
    previous: GitStatus | null,
    next: GitStatus,
  ): void {
    const branchChanged = previous !== null && previous.head.branch !== next.head.branch
    const githubChanged =
      previous !== null && !sameJson(previous.remote?.github ?? null, next.remote?.github ?? null)
    if (branchChanged || githubChanged) resetPullRequest(state)
    const pushed =
      previous?.upstream != null &&
      next.upstream?.name === previous.upstream.name &&
      next.upstream.ahead < previous.upstream.ahead
    if (previous === null || branchChanged || githubChanged || pushed) {
      background(requestPoll(state, true))
    }
  }

  function requestPoll(state: ProjectState, force: boolean): Promise<void> {
    if (disposed) return Promise.resolve()
    if (!force && now() - state.lastPollAt < PULL_REQUEST_MIN_INTERVAL_MS) return Promise.resolve()
    return state.poller.request()
  }

  async function runPoll(state: ProjectState): Promise<void> {
    state.lastPollAt = now()
    const status = state.status
    const github = status?.remote?.github
    if (!status?.repo || !github) {
      clearPullRequests(state)
      return
    }
    const tools = await getTools()
    if (tools.gh.state !== 'ready' || disposed) return

    const branch = status.head.branch
    const [view, list] = await Promise.all([
      branch === null ? null : viewCurrentPullRequest(exec, state.projectPath),
      listBranchPullRequests(exec, state.projectPath),
    ])
    if (disposed) return

    const sameBranch = state.status?.head.branch === branch
    if (branch === null) {
      applyCurrentPullRequest(state, null, null)
    } else if (view?.ok && sameBranch) {
      applyCurrentPullRequest(state, branch, view.value)
    }
    if (view?.ok === false) noteGhFailure(state, 'pr view', view)
    else if (view) logChange(state, 'gh pr view', 'warn', null)
    if (list.ok) {
      logChange(state, 'gh pr list', 'warn', null)
      setBranchPullRequests(state, list.value)
    } else {
      noteGhFailure(state, 'pr list', list)
    }

    if (isLive(state)) {
      if (state.pollTimer !== null) clearTimeout(state.pollTimer)
      const delay = nextPollDelayMs(state.pullRequest?.value ?? null)
      state.pollTimer = setTimeout(() => {
        state.pollTimer = null
        background(requestPoll(state, true))
      }, delay)
      state.pollTimer.unref()
    }
  }

  function noteGhFailure(
    state: ProjectState,
    what: string,
    outcome: { ok: false; reason: 'not-installed' | 'failed'; message: string },
  ): void {
    if (outcome.reason === 'not-installed' && currentTools?.gh.state === 'ready') {
      setTools({ ...currentTools, gh: { state: 'not-installed', version: null, account: null } })
    }
    logChange(state, `gh ${what}`, 'warn', `gh ${what} failed: ${outcome.message}`)
  }

  function applyCurrentPullRequest(
    state: ProjectState,
    branch: string | null,
    value: PullRequest | null,
  ): void {
    state.pullRequest = { branch, value }
    announcePullRequest(state, value)
  }

  function announcePullRequest(state: ProjectState, value: PullRequest | null): void {
    if (sameJson(state.announcedPullRequest, value)) return
    state.announcedPullRequest = value
    pullRequestChanged.emit(state.projectPath, value)
  }

  // The previous branch's pull request must not show on the new branch while gh answers.
  function resetPullRequest(state: ProjectState): void {
    state.pullRequest = null
    announcePullRequest(state, null)
  }

  function setBranchPullRequests(state: ProjectState, map: Map<string, BranchPullRequest>): void {
    if (sameJson([...state.branchPullRequests], [...map])) return
    state.branchPullRequests = map
    branchPullRequestsChanged.emit(state.projectPath)
  }

  function clearPullRequests(state: ProjectState): void {
    resetPullRequest(state)
    if (state.branchPullRequests.size > 0) {
      state.branchPullRequests = EMPTY_BRANCH_PULL_REQUESTS
      branchPullRequestsChanged.emit(state.projectPath)
    }
  }

  async function loadPullRequest(url: string): Promise<PullRequest> {
    const tools = await getTools()
    if (tools.gh.state === 'not-installed') throw new Error(t('git.ghMissing'))
    if (tools.gh.state === 'signed-out') {
      throw new Error(t('git.ghSignedOut'))
    }
    const outcome = await viewPullRequestByUrl(exec, url, homedir())
    if (!outcome.ok) throw new Error(outcome.message)
    pullRequestCache.set(url, { at: now(), value: outcome.value })
    while (pullRequestCache.size > PULL_REQUEST_CACHE_SIZE) {
      const oldest = pullRequestCache.keys().next().value
      if (oldest === undefined) break
      pullRequestCache.delete(oldest)
    }
    return outcome.value
  }

  // Fetch

  function fetchProject(state: ProjectState): Promise<GitOperation> {
    if (state.operation) return Promise.reject(busy())
    state.fetching ??= track(runFetch(state)).finally(() => {
      state.fetching = null
    })
    return state.fetching
  }

  async function runFetch(state: ProjectState): Promise<GitOperation> {
    const result = await exec('git', ['fetch', '--prune'], {
      cwd: state.projectPath,
      timeoutMs: FETCH_TIMEOUT_MS,
    })
    if (result.failure !== null || result.code !== 0) {
      throw new Error(
        result.failure === 'timeout'
          ? `git fetch timed out after ${FETCH_TIMEOUT_MS / 1000} s`
          : result.stderr.trim() || describeFailure(result),
      )
    }
    return { status: (await requestRefresh(state)).status, log: logOf(result) }
  }

  // Writes

  function busy(): HostError {
    return new HostError('busy', t('git.busy'))
  }

  /** Runs one write at a time per project, then refreshes and returns the status with its value. */
  function locked<T>(
    state: ProjectState,
    run: (status: GitStatus) => Promise<T>,
  ): Promise<{ status: GitStatus; value: T }> {
    if (state.operation || state.fetching) return Promise.reject(busy())
    const work = (async (): Promise<{ status: GitStatus; value: T }> => {
      const before = (await requestRefresh(state)).status
      try {
        const value = await run(before)
        const after = await requestRefresh(state)
        if (isLive(state)) background(requestPoll(state, true))
        return { status: after.status, value }
      } catch (error) {
        // What the failure left behind, such as a half-made remote, shows at once.
        refreshInBackground(state)
        throw error
      } finally {
        // Released before the caller hears back, so its next request is not refused.
        state.operation = null
      }
    })()
    // The caller handles the rejection; the lock only needs to know that one is running.
    state.operation = track(work).then(
      () => undefined,
      () => undefined,
    )
    return work
  }

  function exclusive(
    state: ProjectState,
    run: (status: GitStatus) => Promise<string>,
  ): Promise<GitOperation> {
    return locked(state, run).then(({ status, value }) => ({ status, log: value }))
  }

  /** Refuses what the interface never offers: a detached or unborn head, a merge in progress. */
  function checkBranch(status: GitStatus): string {
    if (!status.repo) throw new Error(t('git.notRepository'))
    if (status.operation) throw new Error(t('git.operationInProgress'))
    if (status.head.detached || status.head.branch === null) throw new Error(t('git.noBranch'))
    return status.head.branch
  }

  /** The status's push target, or why there is none, as the interface says it. */
  function pushTarget(status: GitStatus): Extract<PushTarget, { kind: 'remote' }> {
    const to = status.push
    switch (to?.kind) {
      case 'remote':
        return to
      case 'localUpstream':
        throw new Error(t('git.localUpstream'))
      case 'otherName':
        throw new Error(t('git.otherName', { upstream: to.upstream }))
      case 'unknownRemote':
        throw new Error(t('git.unknownRemote'))
      default:
        throw new Error(t('git.noRemote'))
    }
  }

  async function requireGh(): Promise<void> {
    const tools = await getTools()
    if (tools.gh.state === 'not-installed') throw new Error(t('git.ghMissing'))
    if (tools.gh.state === 'signed-out') throw new Error(t('git.ghSignedOut'))
  }

  async function knownStatus(state: ProjectState): Promise<GitStatus> {
    return state.status ?? (await requestRefresh(state)).status
  }

  async function runBackgroundFetch(): Promise<void> {
    if (backgroundFetching) return
    backgroundFetching = true
    try {
      for (const state of [...projects.values()]) {
        if (disposed || !isLive(state) || !state.status?.remote || state.operation) continue
        try {
          await fetchProject(state)
          logChange(state, 'fetch', 'info', null)
        } catch (error) {
          logChange(state, 'fetch', 'info', `Background fetch failed: ${messageOf(error)}`)
        }
      }
    } finally {
      backgroundFetching = false
    }
  }

  // Tool calls

  const callKey = (sessionId: string, toolCallId: string): string => `${sessionId}\0${toolCallId}`

  function pruneCalls(state: ProjectState): void {
    const cutoff = now() - STALE_CALL_MS
    for (const [key, call] of state.calls) {
      if (call.startedAt < cutoff) state.calls.delete(key)
    }
  }

  async function handleToolEnd(
    state: ProjectState,
    call: ToolCall | undefined,
    sessionId: string,
    output: string,
  ): Promise<void> {
    const knownNoPullRequest =
      state.pullRequest?.value === null ? state.pullRequest.branch : undefined
    const after = await requestRefresh(state)
    if (disposed || !call?.before || call.contested) return

    // Parallel calls of one session share the baseline so a change is reported once.
    const prior = state.baseline
    const before = prior && prior.seq > call.before.seq ? prior : call.before
    if (!prior || after.seq > prior.seq) state.baseline = after
    if (after.seq <= before.seq) return

    let newCommits: Awaited<ReturnType<typeof listNewCommits>> = []
    const to = after.status.head.oid
    if (to !== null && to !== before.status.head.oid) {
      try {
        newCommits = await listNewCommits(
          exec,
          state.projectPath,
          before.status.head.oid,
          to,
          Math.floor(call.startedAt / 1000),
        )
      } catch (error) {
        logChange(state, 'commits', 'warn', `Could not list new commits: ${messageOf(error)}`)
      }
    }

    const events = computeGitEvents({
      before: before.status,
      after: after.status,
      newCommits,
      output,
    })
    const fresh = events.filter((event) => {
      if (event.event !== 'pull_request') return true
      if (state.reportedPullRequests.has(event.url)) return false
      state.reportedPullRequests.add(event.url)
      return true
    })
    if (fresh.length > 0 && !disposed) sessionEvents.emit(sessionId, fresh)

    // A pull request opened some other way shows up only once gh has been asked.
    const branch = after.status.head.branch
    if (branch !== null && knownNoPullRequest === branch && fresh.some((e) => e.event === 'push')) {
      await requestPoll(state, true)
      const opened = state.pullRequest
      if (
        !disposed &&
        opened?.branch === branch &&
        opened.value &&
        !state.reportedPullRequests.has(opened.value.url)
      ) {
        state.reportedPullRequests.add(opened.value.url)
        sessionEvents.emit(sessionId, [
          { kind: 'git', event: 'pull_request', url: opened.value.url },
        ])
      }
    }
  }

  const api: GitServiceApi = {
    async status(projectPath) {
      const state = projectFor(projectPath)
      const snapshot = await requestRefresh(state)
      if (isLive(state)) background(requestPoll(state, false))
      return snapshot.status
    },

    retain(projectPath, subscriberId) {
      try {
        const state = projectFor(projectPath)
        const wasLive = isLive(state)
        state.retainers.add(subscriberId)
        if (!wasLive) goLive(state)
      } catch (error) {
        log('warn', `Could not retain ${projectPath}: ${messageOf(error)}`)
      }
    },

    release(projectPath, subscriberId) {
      const state = lookup(projectPath)
      if (!state?.retainers.delete(subscriberId)) return
      if (state.retainers.size === 0) stopLive(state)
    },

    releaseAll(subscriberId) {
      for (const state of projects.values()) {
        if (state.retainers.delete(subscriberId) && state.retainers.size === 0) stopLive(state)
      }
    },

    fetch(projectPath) {
      try {
        return fetchProject(projectFor(projectPath))
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },

    pull(projectPath) {
      return exclusive(projectFor(projectPath), (status) => {
        checkBranch(status)
        if (!status.upstream) throw new Error(t('git.noUpstream'))
        if (status.upstream.ahead > 0 && status.upstream.behind > 0) {
          throw new Error(t('git.diverged', { upstream: status.upstream.name }))
        }
        return pull(exec, status.projectPath)
      })
    },

    push(projectPath, expected) {
      return exclusive(projectFor(projectPath), (status) => {
        const branch = checkBranch(status)
        const to = pushTarget(status)
        if (to.remote !== expected.remote || to.branch !== expected.branch) {
          throw new Error(t('git.pushTargetChanged', { target: `${to.remote}/${to.branch}` }))
        }
        // Behind matters only when the push goes to the upstream itself.
        const upstream = status.upstream
        if (upstream && upstream.name === `${to.remote}/${to.branch}` && upstream.behind > 0) {
          throw new Error(
            t(upstream.ahead > 0 ? 'git.diverged' : 'git.pullFirst', { upstream: upstream.name }),
          )
        }
        return push(exec, status.projectPath, branch, to)
      })
    },

    publish(projectPath, name, visibility) {
      return exclusive(projectFor(projectPath), async (status) => {
        checkBranch(status)
        if (status.push?.kind !== 'noRemote') throw new Error(t('git.remoteExists'))
        await requireGh()
        return publishRepository(exec, status.repo!.root, name, visibility)
      })
    },

    async createPullRequest(projectPath, draft) {
      const state = projectFor(projectPath)
      const { value } = await locked(state, async (status) => {
        await requireGh()
        checkBranch(status)
        const base = status.remote?.github
        const to = status.push
        if (!base || to?.kind !== 'remote' || to.setUpstream || !to.github) {
          throw new Error(t('git.notOnGithub'))
        }
        const sameRepo = to.github.owner === base.owner && to.github.repo === base.repo
        if (sameRepo && to.branch === draft.base) throw new Error(t('git.sameBranch'))
        const created = await createPullRequest(exec, state.projectPath, {
          ...draft,
          repo: `${base.owner}/${base.repo}`,
          head: sameRepo ? to.branch : `${to.github.owner}:${to.branch}`,
        })
        return { url: created.url, head: to.branch }
      })
      try {
        return await api.pullRequest(value.url)
      } catch (error) {
        // The pull request exists; only its details are missing until the next poll.
        logChange(state, 'gh pr view', 'warn', `gh pr view failed: ${messageOf(error)}`)
        return createdPullRequest(value.url, value.head, draft, now())
      }
    },

    async commit(projectPath, oid) {
      const state = projectFor(projectPath)
      await knownStatus(state)
      return readCommitDetails(exec, state.projectPath, oid)
    },

    async changes(projectPath) {
      const state = projectFor(projectPath)
      const status = await knownStatus(state)
      if (!status.repo) return []
      return readChanges(exec, state.projectPath, status.head.oid === null)
    },

    async incoming(projectPath, from) {
      const state = projectFor(projectPath)
      const status = await knownStatus(state)
      const ref = from === 'upstream' ? status.upstream?.name : status.base?.name
      if (!status.repo || !ref || status.head.oid === null) return []
      return readIncoming(exec, state.projectPath, ref)
    },

    async fileDiff(projectPath, path, oldPath, ref) {
      const state = projectFor(projectPath)
      const status = await knownStatus(state)
      if (!status.repo) throw new Error(t('git.notRepository'))
      return readFileDiff(exec, status.repo.root, path, oldPath, ref, status.head.oid === null)
    },

    async pullRequest(url) {
      if (disposed) throw new Error('The git service is disposed')
      if (!GITHUB_PULL_REQUEST_URL.test(url)) throw new Error('Not a GitHub pull request URL')
      const cached = pullRequestCache.get(url)
      if (cached && now() - cached.at < PULL_REQUEST_CACHE_MS) return cached.value
      let load = pullRequestLoads.get(url)
      if (!load) {
        load = track(loadPullRequest(url)).finally(() => pullRequestLoads.delete(url))
        pullRequestLoads.set(url, load)
      }
      return load
    },

    async currentPullRequest(projectPath) {
      const state = projectFor(projectPath)
      if (!state.status) await requestRefresh(state)
      // Undefined while gh has not answered for the branch that is checked out.
      const known = (): PullRequest | null | undefined => {
        const known = state.pullRequest
        return known && known.branch === (state.status?.head.branch ?? null)
          ? known.value
          : undefined
      }
      if (known() === undefined) await requestPoll(state, true)
      return known() ?? null
    },

    branchPullRequests(projectPath) {
      return lookup(projectPath)?.branchPullRequests ?? EMPTY_BRANCH_PULL_REQUESTS
    },

    currentBranch(projectPath) {
      return lookup(projectPath)?.status?.head.branch ?? null
    },

    tools: getTools,

    async reloadTools() {
      const tools = await track(probeTools(exec, homedir()))
      if (!disposed) {
        setTools(tools)
        for (const state of projects.values()) {
          if (isLive(state)) background(requestPoll(state, true))
        }
      }
      return tools
    },

    setEnvironment(next) {
      env = next
    },

    setBackgroundFetch(enabled) {
      if (enabled && backgroundFetch === null && !disposed) {
        backgroundFetch = setInterval(
          () => background(track(runBackgroundFetch())),
          BACKGROUND_FETCH_INTERVAL_MS,
        )
        backgroundFetch.unref()
      } else if (!enabled && backgroundFetch !== null) {
        clearInterval(backgroundFetch)
        backgroundFetch = null
      }
    },

    toolCallStarted(projectPath, sessionId, toolCallId) {
      let state: ProjectState
      try {
        state = projectFor(projectPath)
      } catch (error) {
        log('warn', `Ignoring a tool call in ${projectPath}: ${messageOf(error)}`)
        return
      }
      pruneCalls(state)
      const call: ToolCall = {
        sessionId,
        startedAt: now(),
        before: snapshotOf(state),
        contested: false,
      }
      for (const other of state.calls.values()) {
        if (other.sessionId !== sessionId) {
          other.contested = true
          call.contested = true
        }
      }
      state.calls.set(callKey(sessionId, toolCallId), call)
      // Without any status there is nothing to compare against until one arrives.
      if (call.before === null) {
        background(
          requestRefresh(state).then((snapshot) => {
            call.before ??= snapshot
          }),
        )
      }
    },

    toolCallEnded(projectPath, sessionId, toolCallId, toolKind: ToolKind, output) {
      const state = lookup(projectPath)
      if (!state || disposed) return
      const key = callKey(sessionId, toolCallId)
      const call = state.calls.get(key)
      state.calls.delete(key)
      if (!canChangeRepository(toolKind)) return
      void track(handleToolEnd(state, call, sessionId, output)).catch((error: unknown) =>
        log(
          'error',
          `Could not handle the end of a tool call in ${projectPath}: ${messageOf(error)}`,
        ),
      )
    },

    turnEnded(projectPath, sessionId) {
      const state = lookup(projectPath)
      if (!state || disposed) return
      for (const [key, call] of state.calls) {
        if (call.sessionId === sessionId) state.calls.delete(key)
      }
      refreshInBackground(state)
    },

    onChanged: changed.on,
    onPullRequest: pullRequestChanged.on,
    onBranchPullRequests: branchPullRequestsChanged.on,
    onSessionEvents: sessionEvents.on,
    onTools: toolsChanged.on,

    async dispose() {
      disposed = true
      if (backgroundFetch !== null) clearInterval(backgroundFetch)
      backgroundFetch = null
      for (const state of projects.values()) {
        state.retainers.clear()
        stopLive(state)
      }
      runner.killAll()
      await Promise.allSettled([...pending])
    },
  }
  return api
}
