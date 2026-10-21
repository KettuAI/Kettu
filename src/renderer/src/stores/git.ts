import { create } from 'zustand'
import type { GitStatus, GitTools, PullRequest } from '@shared/git'
import { errorMessage, host } from '@renderer/lib/host'

interface GitStore {
  status: Record<string, GitStatus>
  currentPr: Record<string, PullRequest | null>
  pullRequests: Record<string, PullRequest> // by URL, for chips
  tools: GitTools | null
  /** Why the last tools check failed; cleared while a new check runs. */
  toolsError: string | null
}

export const useGitStore = create<GitStore>()(() => ({
  status: {},
  currentPr: {},
  pullRequests: {},
  tools: null,
  toolsError: null,
}))

export function receiveGitStatus(status: GitStatus): void {
  useGitStore.setState((s) => ({ status: { ...s.status, [status.projectPath]: status } }))
}

export function receiveCurrentPr(projectPath: string, pr: PullRequest | null): void {
  useGitStore.setState((s) => ({ currentPr: { ...s.currentPr, [projectPath]: pr } }))
}

let livePath: string | null = null

/** Keeps the shown project's repository live; only one project is shown per window. */
export function showProject(projectPath: string | null): void {
  if (projectPath === livePath) return
  const previous = livePath
  livePath = projectPath
  if (previous) void host('git.unwatch', { projectPath: previous }).catch(() => {})
  if (!projectPath) return
  void host('git.status', { projectPath })
    .then(receiveGitStatus)
    .catch(() => {})
  void host('git.currentPullRequest', { projectPath })
    .then((pr) => receiveCurrentPr(projectPath, pr))
    .catch(() => {})
}

/** Refreshes the shown project, for window focus; the host coalesces repeated calls. */
export function refreshShownProject(): void {
  if (livePath)
    void host('git.status', { projectPath: livePath })
      .then(receiveGitStatus)
      .catch(() => {})
}

/** Re-subscribes after the agent host restarts. */
export function rewatchGit(): void {
  const path = livePath
  livePath = null
  showProject(path)
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
