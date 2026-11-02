import { create } from 'zustand'
import {
  GITHUB_LOGIN,
  type GitOperation,
  type GitStatus,
  type GitTools,
  type PullRequest,
  type RepositoryVisibility,
} from '@shared/git'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { hostOfPath } from '@renderer/lib/host-paths'

export type GitOperationKind =
  'fetch' | 'pull' | 'push' | 'publishBranch' | 'publishRepo' | 'switch' | 'commit' | 'discard'

export interface RunningOperation {
  kind: GitOperationKind
  startedAt: number
}

export interface FailedOperation {
  kind: GitOperationKind
  /** git's or gh's output, or the host's message. */
  log: string
  busy: boolean
}

/** A write to the repository, with what the host needs to run it. */
export type GitOperationRequest =
  | { kind: 'fetch' }
  | { kind: 'pull' }
  | { kind: 'push'; remote: string; branch: string }
  | { kind: 'publishBranch'; remote: string }
  | { kind: 'publishRepo'; name: string; visibility: RepositoryVisibility }
  | { kind: 'switch'; branch: string; create: boolean }
  | { kind: 'commit'; message: string; paths: string[] }
  | { kind: 'discard'; paths: string[] }

/** A dialog the branch popover or the Files pane opens; it lives outside them, so they can close. */
export type GitDialog =
  | { kind: 'publishRepo' }
  | { kind: 'publishBranch' }
  | { kind: 'createPr' }
  | {
      kind: 'confirmPush'
      operation: Extract<GitOperationRequest, { kind: 'push' }>
      count: number
    }
  | { kind: 'commit'; paths: string[] | null }
  | { kind: 'discard'; paths: string[] }
  | { kind: 'newBranch' }
  | { kind: 'log' }

interface GitStore {
  status: Record<string, GitStatus>
  currentPr: Record<string, PullRequest | null>
  pullRequests: Record<string, PullRequest> // by URL, for chips
  /** By URL, why a chip's details did not load, until they do. */
  pullRequestErrors: Record<string, string>
  /** By login, a chip author's picture as a data: URL, or null when GitHub has none. */
  avatars: Record<string, string | null>
  tools: GitTools | null
  /** Why the last tools check failed; cleared while a new check runs. */
  toolsError: string | null
  /** By project, the fetch, pull, push or publish that is running. */
  running: Record<string, RunningOperation>
  /** By project, the last operation that failed, until the next one starts. */
  failed: Record<string, FailedOperation>
  dialogs: Record<string, GitDialog>
}

export const useGitStore = create<GitStore>()(() => ({
  status: {},
  currentPr: {},
  pullRequests: {},
  pullRequestErrors: {},
  avatars: {},
  tools: null,
  toolsError: null,
  running: {},
  failed: {},
  dialogs: {},
}))

export function receiveGitStatus(status: GitStatus): void {
  useGitStore.setState((s) => ({ status: { ...s.status, [status.projectPath]: status } }))
}

export function receiveCurrentPr(projectPath: string, pr: PullRequest | null): void {
  useGitStore.setState((s) => ({ currentPr: { ...s.currentPr, [projectPath]: pr } }))
}

// The projects a pane in view shows, which keep their repository live.
let livePaths: string[] = []

/** Keeps each shown project's repository live, and lets go of one no pane shows. */
export function showProjects(paths: readonly string[]): void {
  const next = [...new Set(paths)]
  if (next.length === livePaths.length && next.every((path, i) => path === livePaths[i])) return
  const previous = livePaths
  livePaths = next
  for (const path of previous) {
    if (!next.includes(path)) void host('git.unwatch', { projectPath: path }).catch(() => {})
  }
  for (const projectPath of next) {
    if (previous.includes(projectPath)) continue
    void host('git.status', { projectPath })
      .then(receiveGitStatus)
      .catch(() => {})
    void host('git.currentPullRequest', { projectPath })
      .then((pr) => receiveCurrentPr(projectPath, pr))
      .catch(() => {})
  }
}

/** Refreshes the shown projects, for window focus; the host coalesces repeated calls. */
export function refreshShownProject(): void {
  for (const projectPath of livePaths) {
    void host('git.status', { projectPath })
      .then(receiveGitStatus)
      .catch(() => {})
  }
}

/**
 * Re-subscribes after a host restarts, or a new connection to another host opens: this
 * computer's projects for null, that host's for its id.
 */
export function rewatchGit(hostId: string | null = null): void {
  const paths = livePaths
  livePaths = paths.filter((path) => hostOfPath(path) !== hostId)
  showProjects(paths)
}

const RETRY_MS = 60_000
const prLoads = new Map<string, Promise<PullRequest | null>>()

/** A chip's details; a failure is kept and asked again a minute later, or at once by a retry. */
export function loadPullRequest(url: string): Promise<PullRequest | null> {
  const cached = useGitStore.getState().pullRequests[url]
  if (cached) return Promise.resolve(cached)
  let load = prLoads.get(url)
  if (!load) {
    const started: Promise<PullRequest | null> = host('git.pullRequest', { url })
      .then((pr) => {
        useGitStore.setState((s) => ({
          pullRequests: { ...s.pullRequests, [url]: pr },
          pullRequestErrors: without(s.pullRequestErrors, url),
        }))
        return pr
      })
      .catch((error: unknown) => {
        const message = errorMessage(error)
        useGitStore.setState((s) => ({
          pullRequestErrors: { ...s.pullRequestErrors, [url]: message },
        }))
        return null
      })
      .finally(() =>
        setTimeout(() => {
          if (prLoads.get(url) === started) prLoads.delete(url)
        }, RETRY_MS),
      )
    load = started
    prLoads.set(url, load)
  }
  return load
}

export function retryPullRequest(url: string): Promise<PullRequest | null> {
  prLoads.delete(url)
  return loadPullRequest(url)
}

const avatarLoads = new Set<string>()
const avatarFailures = new Map<string, number>()

/** Looks up a chip author's avatar once, and again a minute after it failed to load. */
export function loadAvatar(login: string): void {
  if (!GITHUB_LOGIN.test(login) || login in useGitStore.getState().avatars) return
  const failedAt = avatarFailures.get(login)
  if (avatarLoads.has(login) || (failedAt !== undefined && Date.now() - failedAt < RETRY_MS)) return
  avatarLoads.add(login)
  void (async () => {
    try {
      const url = await host('git.avatarUrl', { login })
      // No URL means GitHub has no picture; a URL whose picture did not load is asked again.
      const picture = url === null ? null : await window.kettu.avatars.load(url)
      if (url !== null && picture === null) {
        avatarFailures.set(login, Date.now())
      } else {
        avatarFailures.delete(login)
        useGitStore.setState((s) => ({ avatars: { ...s.avatars, [login]: picture } }))
      }
    } catch {
      avatarFailures.set(login, Date.now())
    } finally {
      avatarLoads.delete(login)
    }
  })()
}

export async function loadGitTools(): Promise<void> {
  useGitStore.setState({ toolsError: null })
  try {
    useGitStore.setState({ tools: await host('git.tools', undefined) })
  } catch (error) {
    useGitStore.setState({ tools: null, toolsError: errorMessage(error) })
  }
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

/**
 * Runs a write in the project and returns its result, or null when it failed, which then shows
 * with its log until the next operation starts.
 */
export async function runGitOperation(
  projectPath: string,
  request: GitOperationRequest,
): Promise<GitOperation | null> {
  const { kind } = request
  if (useGitStore.getState().running[projectPath]) {
    // Said like the host's own refusal, so a dialog or toast shows why nothing happened.
    useGitStore.setState((s) => ({
      failed: { ...s.failed, [projectPath]: { kind, log: i18n.t('git:failure.busy'), busy: true } },
    }))
    return null
  }
  useGitStore.setState((s) => ({
    running: { ...s.running, [projectPath]: { kind, startedAt: Date.now() } },
    failed: without(s.failed, projectPath),
  }))
  try {
    const result = await send(projectPath, request)
    receiveGitStatus(result.status)
    return result
  } catch (error) {
    useGitStore.setState((s) => ({
      failed: {
        ...s.failed,
        [projectPath]: { kind, log: errorMessage(error), busy: errorCode(error) === 'busy' },
      },
    }))
    return null
  } finally {
    useGitStore.setState((s) => ({ running: without(s.running, projectPath) }))
  }
}

function send(projectPath: string, request: GitOperationRequest): Promise<GitOperation> {
  switch (request.kind) {
    case 'fetch':
      return host('git.fetch', { projectPath })
    case 'pull':
      return host('git.pull', { projectPath })
    case 'push':
      return host('git.push', { projectPath, remote: request.remote, branch: request.branch })
    case 'publishBranch':
      return host('git.publishBranch', { projectPath, remote: request.remote })
    case 'publishRepo':
      return host('git.publish', {
        projectPath,
        name: request.name,
        visibility: request.visibility,
      })
    case 'switch':
      return host('git.switchBranch', {
        projectPath,
        branch: request.branch,
        create: request.create,
      })
    case 'commit':
      return host('git.commitChanges', {
        projectPath,
        message: request.message,
        paths: request.paths,
      })
    case 'discard':
      return host('git.discardChanges', { projectPath, paths: request.paths })
  }
}

/** Opens a pull request with gh; it shows in the popover and the top bar at once. */
export async function createPullRequest(
  projectPath: string,
  draft: { title: string; body: string; base: string; draft: boolean },
): Promise<PullRequest> {
  const pr = await host('git.createPullRequest', { projectPath, ...draft })
  receiveCurrentPr(projectPath, pr)
  useGitStore.setState((s) => ({ pullRequests: { ...s.pullRequests, [pr.url]: pr } }))
  return pr
}

export function dismissGitFailure(projectPath: string): void {
  useGitStore.setState((s) => ({ failed: without(s.failed, projectPath) }))
}

// By project, what had focus when its dialog opened: the button that opened it.
const openers = new Map<string, Element | null>()

export function openGitDialog(projectPath: string, dialog: GitDialog): void {
  openers.set(projectPath, document.activeElement)
  useGitStore.setState((s) => ({ dialogs: { ...s.dialogs, [projectPath]: dialog } }))
}

export function gitDialogOpener(projectPath: string): Element | null {
  return openers.get(projectPath) ?? null
}

export function closeGitDialog(projectPath: string): void {
  useGitStore.setState((s) => ({ dialogs: without(s.dialogs, projectPath) }))
}
