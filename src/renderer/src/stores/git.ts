import { create } from 'zustand'
import type {
  GitOperation,
  GitStatus,
  GitTools,
  PullRequest,
  RepositoryVisibility,
} from '@shared/git'
import { errorCode, errorMessage, host } from '@renderer/lib/host'

export type GitOperationKind = 'fetch' | 'pull' | 'push' | 'publishBranch' | 'publishRepo'

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

/** A fetch, pull, push or publish, with what the host needs to run it. */
export type GitOperationRequest =
  | { kind: 'fetch' }
  | { kind: 'pull' }
  | { kind: 'push' | 'publishBranch'; remote: string; branch: string }
  | { kind: 'publishRepo'; name: string; visibility: RepositoryVisibility }

/** A dialog the branch popover opens; it lives outside the popover, which closes under it. */
export type GitDialog =
  | { kind: 'publishRepo' }
  | { kind: 'createPr' }
  | {
      kind: 'confirmPush'
      operation: Extract<GitOperationRequest, { kind: 'push' | 'publishBranch' }>
      count: number
    }
  | { kind: 'log' }

interface GitStore {
  status: Record<string, GitStatus>
  currentPr: Record<string, PullRequest | null>
  pullRequests: Record<string, PullRequest> // by URL, for chips
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

/** Re-subscribes after the agent host restarts. */
export function rewatchGit(): void {
  const paths = livePaths
  livePaths = []
  showProjects(paths)
}

const prLoads = new Map<string, Promise<PullRequest | null>>()

export function loadPullRequest(url: string): Promise<PullRequest | null> {
  const cached = useGitStore.getState().pullRequests[url]
  if (cached) return Promise.resolve(cached)
  let load = prLoads.get(url)
  if (!load) {
    load = host('git.pullRequest', { url })
      .then((pr) => {
        useGitStore.setState((s) => ({ pullRequests: { ...s.pullRequests, [url]: pr } }))
        return pr
      })
      .catch(() => null)
      .finally(() => setTimeout(() => prLoads.delete(url), 60_000))
    prLoads.set(url, load)
  }
  return load
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
 * Runs a fetch, pull, push or publish in the project; false when it failed, which then shows
 * with its log until the next operation starts.
 */
export async function runGitOperation(
  projectPath: string,
  request: GitOperationRequest,
): Promise<boolean> {
  const { kind } = request
  if (useGitStore.getState().running[projectPath]) return false
  useGitStore.setState((s) => ({
    running: { ...s.running, [projectPath]: { kind, startedAt: Date.now() } },
    failed: without(s.failed, projectPath),
  }))
  try {
    let result: GitOperation
    if (request.kind === 'fetch') result = await host('git.fetch', { projectPath })
    else if (request.kind === 'pull') result = await host('git.pull', { projectPath })
    else if (request.kind === 'publishRepo') {
      const { name, visibility } = request
      result = await host('git.publish', { projectPath, name, visibility })
    } else {
      const { remote, branch } = request
      result = await host('git.push', { projectPath, remote, branch })
    }
    receiveGitStatus(result.status)
    return true
  } catch (error) {
    useGitStore.setState((s) => ({
      failed: {
        ...s.failed,
        [projectPath]: { kind, log: errorMessage(error), busy: errorCode(error) === 'busy' },
      },
    }))
    return false
  } finally {
    useGitStore.setState((s) => ({ running: without(s.running, projectPath) }))
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

export function openGitDialog(projectPath: string, dialog: GitDialog): void {
  useGitStore.setState((s) => ({ dialogs: { ...s.dialogs, [projectPath]: dialog } }))
}

export function closeGitDialog(projectPath: string): void {
  useGitStore.setState((s) => ({ dialogs: without(s.dialogs, projectPath) }))
}
