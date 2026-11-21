import { create } from 'zustand'
import {
  GITHUB_LOGIN,
  type GitOperation,
  type GitStatus,
  type GitHubReference,
  type GitTools,
  type Issue,
  type IssueLookup,
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

/** A dialog the branch popover, the Git pane or the Files pane opens; it lives outside them. */
export type GitDialog =
  | { kind: 'publishRepo' }
  | { kind: 'publishBranch' }
  | {
      kind: 'confirmPush'
      operation: Extract<GitOperationRequest, { kind: 'push' }>
      count: number
    }
  | { kind: 'discard'; paths: string[] }
  | { kind: 'newBranch' }
  | { kind: 'log' }

/** The Git pane's pages. */
export type GitPaneTab = 'changes' | 'commits' | 'pr'

/** A project's commit box, which keeps what is typed while the pane shows another page. */
export interface CommitBox {
  message: string
  /** The user typed in it, so a drafted message never replaces what is there. */
  edited: boolean
  /** A message was asked for since the last commit, so the box does not ask by itself again. */
  drafted: boolean
  /** Mod+Enter commits and pushes, as the box was opened by Commit and push. */
  andPush: boolean
  /** A message is being written, which the box shows whichever page the pane is on. */
  writing: boolean
  /** Why the last draft or commit failed. */
  problem: string | null
}

export const EMPTY_BOX: CommitBox = {
  message: '',
  edited: false,
  drafted: false,
  andPush: false,
  writing: false,
  problem: null,
}

/** What opened the commit box: the files it is for, or all of them, and what Mod+Enter does. */
export interface CommitAsk {
  only: string[] | null
  andPush: boolean
}

/** A project's new pull request, which keeps what is typed while the pane shows another page. */
export interface PullRequestForm {
  title: string
  body: string
  /** The branch to merge into; null until the form picks the default one. */
  base: string | null
  draft: boolean
  /** The user typed in the field, so a drafted text never replaces it. */
  titleEdited: boolean
  bodyEdited: boolean
  /** The base a draft was asked for, so the form does not ask again for the same one. */
  draftedFor: string | null
  drafting: boolean
  draftError: string | null
}

export const EMPTY_PULL_REQUEST_FORM: PullRequestForm = {
  title: '',
  body: '',
  base: null,
  draft: false,
  titleEdited: false,
  bodyEdited: false,
  draftedFor: null,
  drafting: false,
  draftError: null,
}

interface GitStore {
  status: Record<string, GitStatus>
  currentPr: Record<string, PullRequest | null>
  pullRequests: Record<string, PullRequest> // by URL, for references
  issues: Record<string, Issue> // by URL, for references
  /** By issue URL, the pull request URL GitHub said it really is. */
  pullRequestAliases: Record<string, string>
  /** By URL, why a reference's details did not load, until they do. */
  referenceErrors: Record<string, string>
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
  /** By panel, the page the Git pane shows. */
  paneTab: Record<string, GitPaneTab>
  /** By project, the changed files the user left out of the next commit; the rest are ticked. */
  leftOut: Record<string, string[]>
  /** By project, the commit box. */
  box: Record<string, CommitBox>
  /** By project, an opener's wish for the commit box, until the Changes page takes it. */
  commitAsk: Record<string, CommitAsk>
  /** By project, the new pull request's form. */
  pullRequestForm: Record<string, PullRequestForm>
}

export const useGitStore = create<GitStore>()(() => ({
  status: {},
  currentPr: {},
  pullRequests: {},
  issues: {},
  pullRequestAliases: {},
  referenceErrors: {},
  avatars: {},
  tools: null,
  toolsError: null,
  running: {},
  failed: {},
  dialogs: {},
  paneTab: {},
  leftOut: {},
  box: {},
  commitAsk: {},
  pullRequestForm: {},
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
  syncReferences(true)
}

/**
 * Re-subscribes after a host restarts, or a new connection to another host opens: this
 * computer's projects for null, that host's for its id.
 */
export function rewatchGit(hostId: string | null = null): void {
  const paths = livePaths
  livePaths = paths.filter((path) => hostOfPath(path) !== hostId)
  showProjects(paths)
  if (hostId === null) syncReferences(true)
}

const RETRY_MS = 60_000
// A card shown this long after its details were read reads them again.
const STALE_MS = 60_000
const referenceLoads = new Map<string, Promise<unknown>>()
const loadedAt = new Map<string, number>()

function receivePullRequest(pr: PullRequest, asked: string): void {
  loadedAt.set(asked, Date.now())
  useGitStore.setState((s) => ({
    pullRequests: { ...s.pullRequests, [pr.url]: pr },
    pullRequestAliases:
      asked === pr.url ? s.pullRequestAliases : { ...s.pullRequestAliases, [asked]: pr.url },
    referenceErrors: without(s.referenceErrors, asked),
  }))
}

// One load per URL at a time; a failure is kept and asked again a minute later, or by a retry.
function loadOnce(url: string, run: () => Promise<void>): Promise<void> {
  let load = referenceLoads.get(url) as Promise<void> | undefined
  if (!load) {
    const started: Promise<void> = run()
      .catch((error: unknown) => {
        const message = errorMessage(error)
        useGitStore.setState((s) => ({
          referenceErrors: { ...s.referenceErrors, [url]: message },
        }))
      })
      .finally(() =>
        setTimeout(() => {
          if (referenceLoads.get(url) === started) referenceLoads.delete(url)
        }, RETRY_MS),
      )
    load = started
    referenceLoads.set(url, load)
  }
  return load
}

/** A pull request's details for a reference or a card; resolves to null when they did not load. */
export async function loadPullRequest(url: string, fresh = false): Promise<PullRequest | null> {
  const cached = useGitStore.getState().pullRequests[url]
  if (cached && !fresh) return cached
  await loadOnce(url, async () => receivePullRequest(await host('git.pullRequest', { url }), url))
  return useGitStore.getState().pullRequests[url] ?? null
}

/** An issue's details; GitHub may answer that the address is a pull request. */
function loadIssue(url: string, fresh = false): Promise<void> {
  const s = useGitStore.getState()
  if (!fresh && (s.issues[url] || s.pullRequestAliases[url])) return Promise.resolve()
  return loadOnce(url, async () => {
    receiveReference(url, await host('git.issue', { url }))
  })
}

/** What the host says a reference now is, read for a request or pushed because it changed. */
export function receiveReference(url: string, found: IssueLookup): void {
  if (found.kind === 'pull') {
    receivePullRequest(found.pullRequest, url)
    return
  }
  loadedAt.set(url, Date.now())
  useGitStore.setState((s) => ({
    issues: { ...s.issues, [url]: found.issue },
    referenceErrors: without(s.referenceErrors, url),
  }))
}

/** Loads what a reference names, once; a card asks with `fresh` to read a live one again. */
export function loadReference(ref: GitHubReference, fresh = false): void {
  const again = fresh && isStale(ref.url)
  if (again) forget(ref.url)
  void (ref.kind === 'pull' ? loadPullRequest(ref.url, again) : loadIssue(ref.url, again))
}

export function retryReference(ref: GitHubReference): Promise<void> {
  forget(ref.url)
  return ref.kind === 'pull'
    ? loadPullRequest(ref.url, true).then(() => {})
    : loadIssue(ref.url, true)
}

// Merged and closed pull requests and closed issues do not change enough to read again.
function isStale(url: string): boolean {
  const at = loadedAt.get(url)
  if (at === undefined || Date.now() - at < STALE_MS) return false
  const s = useGitStore.getState()
  const pr = s.pullRequests[s.pullRequestAliases[url] ?? url]
  if (pr) return pr.state === 'open' || pr.state === 'draft'
  return s.issues[url]?.state === 'open'
}

// Lets the next load ask gh again; what is shown stays until the new answer replaces it.
function forget(url: string): void {
  loadedAt.delete(url)
  referenceLoads.delete(url)
}

/** Whether a reference's state is final, so the host need not read it again. */
export function isReferenceSettled(s: GitStore, ref: GitHubReference): boolean {
  const pr = s.pullRequests[s.pullRequestAliases[ref.url] ?? ref.url]
  if (pr) return pr.state === 'merged' || pr.state === 'closed'
  const issue = ref.kind === 'issue' ? s.issues[ref.url] : undefined
  return issue !== undefined && issue.state !== 'open'
}

// The references on screen, counted once for each place that shows one.
const shownReferences = new Map<string, number>()
let sentReferences = ''
let referenceSync: ReturnType<typeof setTimeout> | null = null

/** Tells the host a reference is on screen, so it keeps its state current, until released. */
export function watchReference(url: string): () => void {
  shownReferences.set(url, (shownReferences.get(url) ?? 0) + 1)
  scheduleReferenceSync()
  return () => {
    const left = (shownReferences.get(url) ?? 1) - 1
    if (left > 0) shownReferences.set(url, left)
    else shownReferences.delete(url)
    scheduleReferenceSync()
  }
}

// Scrolling shows and hides many at once, so one request carries the settled set.
function scheduleReferenceSync(): void {
  if (referenceSync !== null) return
  referenceSync = setTimeout(() => {
    referenceSync = null
    syncReferences(false)
  }, 300)
}

/**
 * Sends the shown references to the host, none while the window is hidden. `again` sends them
 * though they did not change, which makes the host read the stale ones at once: on focus, on
 * showing the window, and after the host restarted.
 */
export function syncReferences(again: boolean): void {
  const urls = document.visibilityState === 'visible' ? [...shownReferences.keys()] : []
  const key = urls.join('\n')
  if (key === sentReferences && (!again || key === '')) return
  sentReferences = key
  void host('git.watchReferences', { urls }).catch(() => {})
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

/** Reads the project's repository and pull request again, as opening the popover or pane does. */
export function refreshGitProject(projectPath: string): void {
  void host('git.status', { projectPath }).then(receiveGitStatus, () => {})
  void host('git.currentPullRequest', { projectPath }).then(
    (current) => receiveCurrentPr(projectPath, current),
    () => {},
  )
  if (!useGitStore.getState().tools) void loadGitTools()
}

export function setGitPaneTab(panel: string, tab: GitPaneTab): void {
  useGitStore.setState((s) => ({ paneTab: { ...s.paneTab, [panel]: tab } }))
}

export function setLeftOut(projectPath: string, paths: string[]): void {
  useGitStore.setState((s) => ({ leftOut: { ...s.leftOut, [projectPath]: paths } }))
}

export function updateCommitBox(projectPath: string, change: Partial<CommitBox>): void {
  useGitStore.setState((s) => ({
    box: { ...s.box, [projectPath]: { ...(s.box[projectPath] ?? EMPTY_BOX), ...change } },
  }))
}

export function updatePullRequestForm(projectPath: string, change: Partial<PullRequestForm>): void {
  useGitStore.setState((s) => ({
    pullRequestForm: {
      ...s.pullRequestForm,
      [projectPath]: { ...(s.pullRequestForm[projectPath] ?? EMPTY_PULL_REQUEST_FORM), ...change },
    },
  }))
}

export function clearPullRequestForm(projectPath: string): void {
  useGitStore.setState((s) => ({ pullRequestForm: without(s.pullRequestForm, projectPath) }))
}

/** Takes the opener's wish for the commit box, if there is one. */
export function takeCommitAsk(projectPath: string): CommitAsk | null {
  const ask = useGitStore.getState().commitAsk[projectPath] ?? null
  if (ask) useGitStore.setState((s) => ({ commitAsk: without(s.commitAsk, projectPath) }))
  return ask
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
