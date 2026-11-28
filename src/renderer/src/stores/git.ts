import { create } from 'zustand'
import {
  GITHUB_LOGIN,
  type GitOperation,
  type GitStatus,
  type GitHubReference,
  type GitTools,
  type Issue,
  type PullRequest,
  type PullRequestStack,
  type ReferenceLookup,
  type RepositoryReferenceItem,
  type RepositoryVisibility,
  type StackUnavailableReason,
} from '@shared/git'
import { errorCode, errorMessage, host, hostAt } from '@renderer/lib/host'
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

/** Per-host GitHub reference cache, avatars, and git/gh tool detection state. */
export interface HostGitState {
  pullRequests: Record<string, PullRequest> // by URL, for references
  issues: Record<string, Issue> // by URL, for references
  stacks: Record<string, PullRequestStack> // by URL, for references
  /** By stack URL, why stack details fell back cleanly instead of showing an error. */
  stackUnavailable: Record<string, StackUnavailableReason>
  /** By issue URL, the pull request URL GitHub said it really is. */
  pullRequestAliases: Record<string, string>
  /** By URL, why a reference's details did not load, until they do. */
  referenceErrors: Record<string, string>
  /** By canonical URL, lightweight issue/PR summary remembered from the `#` reference picker. */
  referenceSummaries: Record<string, RepositoryReferenceItem>
  /** By login, a chip author's picture as a data: URL, or null when GitHub has none. */
  avatars: Record<string, string | null>
  tools: GitTools | null
  /** Why the last tools check failed; cleared while a new check runs. */
  toolsError: string | null
}

const EMPTY_HOST_GIT: HostGitState = {
  pullRequests: {},
  issues: {},
  stacks: {},
  stackUnavailable: {},
  pullRequestAliases: {},
  referenceErrors: {},
  referenceSummaries: {},
  avatars: {},
  tools: null,
  toolsError: null,
}

const LOCAL_HOST_KEY = ''

/** The store key for a host: empty string for this computer, or the remote host id. */
export function gitHostKey(hostId: string | null): string {
  return hostId ?? LOCAL_HOST_KEY
}

function scopedKey(hostId: string | null, item: string): string {
  return `${gitHostKey(hostId)}\0${item}`
}

export interface GitStore {
  status: Record<string, GitStatus>
  currentPr: Record<string, PullRequest | null>
  /** Per-host GitHub references, avatars, and git/gh tools, keyed by `gitHostKey(hostId)`. */
  byHost: Record<string, HostGitState>
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
  byHost: {},
  running: {},
  failed: {},
  dialogs: {},
  paneTab: {},
  leftOut: {},
  box: {},
  commitAsk: {},
  pullRequestForm: {},
}))

/** The GitHub reference cache and tool status of `hostId` (null for this computer). */
export function hostGitOf(s: Pick<GitStore, 'byHost'>, hostId: string | null): HostGitState {
  return s.byHost[gitHostKey(hostId)] ?? EMPTY_HOST_GIT
}

/** The detected git/gh tools of `hostId` (null for this computer). */
export function gitToolsOf(s: Pick<GitStore, 'byHost'>, hostId: string | null): GitTools | null {
  return hostGitOf(s, hostId).tools
}

/** The GitHub CLI state of `hostId` (null for this computer), or null before detection completes. */
export function ghStateOf(
  s: Pick<GitStore, 'byHost'>,
  hostId: string | null,
): GitTools['gh']['state'] | null {
  return hostGitOf(s, hostId).tools?.gh.state ?? null
}

/** A cached pull request on `hostId` by URL (following issue-to-PR aliases). */
export function pullRequestOf(
  s: Pick<GitStore, 'byHost'>,
  hostId: string | null,
  url: string,
): PullRequest | undefined {
  const hostState = hostGitOf(s, hostId)
  return hostState.pullRequests[hostState.pullRequestAliases[url] ?? url]
}

/** A cached issue on `hostId` by URL. */
export function issueOf(
  s: Pick<GitStore, 'byHost'>,
  hostId: string | null,
  url: string,
): Issue | undefined {
  return hostGitOf(s, hostId).issues[url]
}

/** A cached pull request stack on `hostId` by URL. */
export function stackOf(
  s: Pick<GitStore, 'byHost'>,
  hostId: string | null,
  url: string,
): PullRequestStack | undefined {
  return hostGitOf(s, hostId).stacks[url]
}

/** Why loading a pull request stack on `hostId` degraded cleanly, or null. */
export function stackUnavailableOf(
  s: Pick<GitStore, 'byHost'>,
  hostId: string | null,
  url: string,
): StackUnavailableReason | null {
  return hostGitOf(s, hostId).stackUnavailable[url] ?? null
}

/** Why loading a reference on `hostId` last failed, or null. */
export function referenceErrorOf(
  s: Pick<GitStore, 'byHost'>,
  hostId: string | null,
  url: string,
): string | null {
  return hostGitOf(s, hostId).referenceErrors[url] ?? null
}

/** A lightweight issue/PR summary remembered from the `#` picker until full details load. */
export function referenceSummaryOf(
  s: Pick<GitStore, 'byHost'>,
  hostId: string | null,
  url: string,
): RepositoryReferenceItem | undefined {
  return hostGitOf(s, hostId).referenceSummaries[url]
}

/** Remembers a picked issue/PR summary so its newly inserted chip shows state and title immediately. */
export function rememberReferenceSummary(
  item: RepositoryReferenceItem,
  hostId: string | null = null,
): void {
  updateHostGit(hostId, (h) => ({
    referenceSummaries: setCapped(h.referenceSummaries, item.url, item, MAX_CACHED_REFS),
  }))
}

/** A cached GitHub author avatar data URL on `hostId`, null when none exists, or undefined. */
export function avatarOf(
  s: Pick<GitStore, 'byHost'>,
  hostId: string | null,
  login: string,
): string | null | undefined {
  return hostGitOf(s, hostId).avatars[login]
}

function updateHostGit(
  hostId: string | null,
  patch: (current: HostGitState) => Partial<HostGitState>,
): void {
  const key = gitHostKey(hostId)
  useGitStore.setState((s) => {
    const current = s.byHost[key] ?? EMPTY_HOST_GIT
    return { byHost: { ...s.byHost, [key]: { ...current, ...patch(current) } } }
  })
}

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
  syncReferences(true, hostId)
}

/** Clears sent-watch tracking when a remote host connection closes, so reconnect re-subscribes. */
export function gitHostClosed(hostId: string): void {
  sentReferencesByHost.delete(hostId)
}

/** Drops all cached GitHub references, avatars, tools, and watches for a removed remote host. */
export function forgetHostGit(hostId: string): void {
  const prefix = `${gitHostKey(hostId)}\0`
  for (const key of referenceLoads.keys()) {
    if (key.startsWith(prefix)) referenceLoads.delete(key)
  }
  loadedAtByHost.delete(gitHostKey(hostId))
  for (const key of avatarLoads) {
    if (key.startsWith(prefix)) avatarLoads.delete(key)
  }
  avatarFailuresByHost.delete(gitHostKey(hostId))
  shownReferencesByHost.delete(hostId)
  sentReferencesByHost.delete(hostId)
  toolsInFlight.delete(hostId)
  toolsSeq.delete(hostId)
  useGitStore.setState((s) => {
    const key = gitHostKey(hostId)
    if (!(key in s.byHost)) return s
    return { byHost: without(s.byHost, key) }
  })
}

const RETRY_MS = 60_000
// A card shown this long after its details were read reads them again.
const STALE_MS = 60_000
const MAX_CACHED_REFS = 200
const MAX_CACHED_AVATARS = 200
const referenceLoads = new Map<string, Promise<unknown>>()
const loadedAtByHost = new Map<string, Map<string, number>>()

function setLoadedAt(hostId: string | null, url: string, at: number): void {
  const hostKey = gitHostKey(hostId)
  let loadedAt = loadedAtByHost.get(hostKey)
  if (!loadedAt) {
    loadedAt = new Map()
    loadedAtByHost.set(hostKey, loadedAt)
  }
  loadedAt.delete(url)
  loadedAt.set(url, at)
  while (loadedAt.size > MAX_CACHED_REFS) {
    const oldest = loadedAt.keys().next().value
    if (oldest === undefined || oldest === url) break
    loadedAt.delete(oldest)
  }
}

function setCapped<T>(
  record: Record<string, T>,
  key: string,
  value: T,
  limit: number,
): Record<string, T> {
  const next = { ...record }
  if (key in next) delete next[key]
  next[key] = value
  const keys = Object.keys(next)
  for (let i = 0; keys.length - i > limit; i++) {
    const oldest = keys[i]!
    if (oldest === key) continue
    delete next[oldest]
  }
  return next
}

function receivePullRequest(pr: PullRequest, asked: string, hostId: string | null = null): void {
  setLoadedAt(hostId, asked, Date.now())
  updateHostGit(hostId, (h) => ({
    pullRequests: setCapped(h.pullRequests, pr.url, pr, MAX_CACHED_REFS),
    pullRequestAliases:
      asked === pr.url
        ? h.pullRequestAliases
        : setCapped(h.pullRequestAliases, asked, pr.url, MAX_CACHED_REFS),
    referenceErrors: without(h.referenceErrors, asked),
  }))
}

// One load per (host, URL) at a time; a failure is kept and asked again a minute later, or by a retry.
function loadOnce(hostId: string | null, url: string, run: () => Promise<void>): Promise<void> {
  const key = scopedKey(hostId, url)
  let load = referenceLoads.get(key) as Promise<void> | undefined
  if (!load) {
    const started: Promise<void> = run()
      .catch((error: unknown) => {
        const message = errorMessage(error)
        updateHostGit(hostId, (h) => ({
          referenceErrors: setCapped(h.referenceErrors, url, message, MAX_CACHED_REFS),
        }))
      })
      .finally(() =>
        setTimeout(() => {
          if (referenceLoads.get(key) === started) referenceLoads.delete(key)
        }, RETRY_MS),
      )
    load = started
    referenceLoads.set(key, load)
  }
  return load
}

/** A pull request's details for a reference or a card; resolves to null when they did not load. */
export async function loadPullRequest(
  url: string,
  fresh = false,
  hostId: string | null = null,
): Promise<PullRequest | null> {
  const cached = hostGitOf(useGitStore.getState(), hostId).pullRequests[url]
  if (cached && !fresh) return cached
  await loadOnce(hostId, url, async () =>
    receivePullRequest(await hostAt(hostId, 'git.pullRequest', { url }), url, hostId),
  )
  return hostGitOf(useGitStore.getState(), hostId).pullRequests[url] ?? null
}

/** An issue's details; GitHub may answer that the address is a pull request. */
function loadIssue(url: string, fresh = false, hostId: string | null = null): Promise<void> {
  const h = hostGitOf(useGitStore.getState(), hostId)
  if (!fresh && (h.issues[url] || h.pullRequestAliases[url])) return Promise.resolve()
  return loadOnce(hostId, url, async () => {
    receiveReference(url, await hostAt(hostId, 'git.issue', { url }), hostId)
  })
}

/** A pull request stack's details; degrades cleanly rather than surfacing raw host errors. */
function loadStack(
  url: string,
  fresh = false,
  forceRefresh = false,
  hostId: string | null = null,
): Promise<void> {
  const h = hostGitOf(useGitStore.getState(), hostId)
  if (!fresh && (h.stacks[url] || h.stackUnavailable[url])) return Promise.resolve()
  return loadOnce(hostId, url, async () => {
    try {
      const found = await hostAt(hostId, 'git.stack', forceRefresh ? { url, fresh: true } : { url })
      receiveReference(url, found, hostId)
    } catch {
      receiveReference(url, { kind: 'unavailable', reason: 'unavailable' }, hostId)
    }
  })
}

/** What the host says a reference now is, read for a request or pushed because it changed. */
export function receiveReference(
  url: string,
  found: ReferenceLookup,
  hostId: string | null = null,
): void {
  if (found.kind === 'pull') {
    receivePullRequest(found.pullRequest, url, hostId)
    return
  }
  if (found.kind === 'stack') {
    setLoadedAt(hostId, url, Date.now())
    updateHostGit(hostId, (h) => ({
      stacks: setCapped(h.stacks, url, found.stack, MAX_CACHED_REFS),
      stackUnavailable: without(h.stackUnavailable, url),
      referenceErrors: without(h.referenceErrors, url),
    }))
    return
  }
  if (found.kind === 'unavailable') {
    setLoadedAt(hostId, url, Date.now())
    updateHostGit(hostId, (h) => {
      // Keep an already-loaded stack visible on transient refresh issues instead of flashing away.
      if (h.stacks[url] && (found.reason === 'timeout' || found.reason === 'unavailable')) {
        return { referenceErrors: without(h.referenceErrors, url) }
      }
      return {
        stacks:
          found.reason === 'not-found' || found.reason === 'forbidden'
            ? without(h.stacks, url)
            : h.stacks,
        stackUnavailable: setCapped(h.stackUnavailable, url, found.reason, MAX_CACHED_REFS),
        referenceErrors: without(h.referenceErrors, url),
      }
    })
    return
  }
  setLoadedAt(hostId, url, Date.now())
  updateHostGit(hostId, (h) => ({
    issues: setCapped(h.issues, url, found.issue, MAX_CACHED_REFS),
    referenceErrors: without(h.referenceErrors, url),
  }))
}

/** Loads what a reference names, once; a card asks with `fresh` to read a live one again. */
export function loadReference(
  ref: GitHubReference,
  fresh = false,
  hostId: string | null = null,
): void {
  const again = fresh && isStale(hostId, ref.url)
  if (again) forget(hostId, ref.url)
  if (ref.kind === 'pull') {
    void loadPullRequest(ref.url, again, hostId)
    return
  }
  if (ref.kind === 'stack') {
    void loadStack(ref.url, again, false, hostId)
    return
  }
  void loadIssue(ref.url, again, hostId)
}

export function retryReference(ref: GitHubReference, hostId: string | null = null): Promise<void> {
  forget(hostId, ref.url)
  if (!gitToolsOf(useGitStore.getState(), hostId)) void loadGitTools(hostId)
  if (ref.kind === 'pull') return loadPullRequest(ref.url, true, hostId).then(() => {})
  if (ref.kind === 'stack') return loadStack(ref.url, true, true, hostId)
  return loadIssue(ref.url, true, hostId)
}

// Merged and closed pull requests, closed issues, and closed/unreadable stacks do not change enough to read again.
function isStale(hostId: string | null, url: string): boolean {
  const h = hostGitOf(useGitStore.getState(), hostId)
  const unavailable = h.stackUnavailable[url]
  if (
    (unavailable === 'gh-missing' || unavailable === 'gh-signed-out') &&
    h.tools?.gh.state === 'ready'
  ) {
    return true
  }
  const at = loadedAtByHost.get(gitHostKey(hostId))?.get(url)
  if (at === undefined || Date.now() - at < STALE_MS) return false
  const pr = h.pullRequests[h.pullRequestAliases[url] ?? url]
  if (pr) return pr.state === 'open' || pr.state === 'draft'
  const stack = h.stacks[url]
  if (stack) return stack.state === 'open'
  if (unavailable) return unavailable === 'timeout' || unavailable === 'unavailable'
  return h.issues[url]?.state === 'open'
}

// Lets the next load ask gh again; what is shown stays until the new answer replaces it.
function forget(hostId: string | null, url: string): void {
  loadedAtByHost.get(gitHostKey(hostId))?.delete(url)
  referenceLoads.delete(scopedKey(hostId, url))
}

/** Whether a reference's state is final, so the host need not read it again. */
export function isReferenceSettled(
  s: GitStore,
  ref: GitHubReference,
  hostId: string | null = null,
): boolean {
  const h = hostGitOf(s, hostId)
  const pr = h.pullRequests[h.pullRequestAliases[ref.url] ?? ref.url]
  if (pr) return pr.state === 'merged' || pr.state === 'closed'
  if (ref.kind === 'stack') {
    const stack = h.stacks[ref.url]
    if (stack) return stack.state === 'closed'
    const unavailable = h.stackUnavailable[ref.url]
    return unavailable !== undefined
  }
  const issue = ref.kind === 'issue' ? h.issues[ref.url] : undefined
  return issue !== undefined && issue.state !== 'open'
}

// The references on screen, counted once per host for each place that shows one.
const shownReferencesByHost = new Map<string | null, Map<string, number>>()
const sentReferencesByHost = new Map<string | null, string>()
let referenceSync: ReturnType<typeof setTimeout> | null = null

/** Tells the host a reference is on screen, so it keeps its state current, until released. */
export function watchReference(url: string, hostId: string | null = null): () => void {
  let shown = shownReferencesByHost.get(hostId)
  if (!shown) {
    shown = new Map()
    shownReferencesByHost.set(hostId, shown)
  }
  shown.set(url, (shown.get(url) ?? 0) + 1)
  scheduleReferenceSync()
  let released = false
  return () => {
    if (released) return
    released = true
    const current = shownReferencesByHost.get(hostId)
    if (!current) return
    const left = (current.get(url) ?? 1) - 1
    if (left > 0) current.set(url, left)
    else current.delete(url)
    if (current.size === 0) shownReferencesByHost.delete(hostId)
    scheduleReferenceSync()
  }
}

// Scrolling shows and hides many at once, so one request per host carries the settled set.
function scheduleReferenceSync(): void {
  if (referenceSync !== null) return
  referenceSync = setTimeout(() => {
    referenceSync = null
    syncReferences(false)
  }, 300)
}

function syncHostReferences(hostId: string | null, again: boolean): void {
  const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
  const shown = shownReferencesByHost.get(hostId)
  const urls = visible && shown ? [...shown.keys()] : []
  const key = urls.join('\n')
  const sent = sentReferencesByHost.get(hostId) ?? ''
  if (key === sent && (!again || key === '')) return
  if (key === '') sentReferencesByHost.delete(hostId)
  else sentReferencesByHost.set(hostId, key)
  void hostAt(hostId, 'git.watchReferences', { urls }).catch(() => {
    if (key !== '' && sentReferencesByHost.get(hostId) === key) {
      sentReferencesByHost.delete(hostId)
    }
  })
}

/**
 * Sends the shown references to each host (or only `targetHost` when given), none while the
 * window is hidden. `again` sends them though they did not change, which makes the host read the
 * stale ones at once: on focus, on showing the window, and after the host restarted or reconnected.
 */
export function syncReferences(again: boolean, targetHost?: string | null): void {
  if (targetHost !== undefined) {
    syncHostReferences(targetHost, again)
    return
  }
  const hosts = new Set<string | null>([
    ...shownReferencesByHost.keys(),
    ...sentReferencesByHost.keys(),
  ])
  for (const hostId of hosts) syncHostReferences(hostId, again)
}

const avatarLoads = new Set<string>()
const avatarFailuresByHost = new Map<string, Map<string, number>>()

function recordAvatarFailure(hostId: string | null, login: string): void {
  const hostKey = gitHostKey(hostId)
  let failures = avatarFailuresByHost.get(hostKey)
  if (!failures) {
    failures = new Map()
    avatarFailuresByHost.set(hostKey, failures)
  }
  failures.delete(login)
  failures.set(login, Date.now())
  if (failures.size > MAX_CACHED_AVATARS) {
    failures.delete(failures.keys().next().value!)
  }
}

/** Looks up a chip author's avatar once on `hostId`, and again a minute after it failed to load. */
export function loadAvatar(login: string, hostId: string | null = null): void {
  if (!GITHUB_LOGIN.test(login) || login in hostGitOf(useGitStore.getState(), hostId).avatars) {
    return
  }
  const loadKey = scopedKey(hostId, login)
  const failures = avatarFailuresByHost.get(gitHostKey(hostId))
  const failedAt = failures?.get(login)
  if (avatarLoads.has(loadKey) || (failedAt !== undefined && Date.now() - failedAt < RETRY_MS)) {
    return
  }
  avatarLoads.add(loadKey)
  void (async () => {
    try {
      const url = await hostAt(hostId, 'git.avatarUrl', { login })
      // No URL means GitHub has no picture; a URL whose picture did not load is asked again.
      const picture = url === null ? null : await window.kettu.avatars.load(url)
      if (url !== null && picture === null) {
        recordAvatarFailure(hostId, login)
      } else {
        avatarFailuresByHost.get(gitHostKey(hostId))?.delete(login)
        updateHostGit(hostId, (h) => ({
          avatars: setCapped(h.avatars, login, picture, MAX_CACHED_AVATARS),
        }))
      }
    } catch {
      recordAvatarFailure(hostId, login)
    } finally {
      avatarLoads.delete(loadKey)
    }
  })()
}

const toolsInFlight = new Map<string | null, Promise<void>>()
const toolsSeq = new Map<string | null, number>()

function clearAuthStackFallbacks(
  hostId: string | null,
  current: HostGitState,
  tools: GitTools,
): Record<string, StackUnavailableReason> {
  if (tools.gh.state !== 'ready') return current.stackUnavailable
  let changed = false
  const next: Record<string, StackUnavailableReason> = {}
  for (const [url, reason] of Object.entries(current.stackUnavailable)) {
    if (reason === 'gh-missing' || reason === 'gh-signed-out') {
      forget(hostId, url)
      changed = true
    } else {
      next[url] = reason
    }
  }
  return changed ? next : current.stackUnavailable
}

/** Applies a `git.tools` push event from `hostId` (null for this computer). */
export function receiveGitTools(hostId: string | null, tools: GitTools): void {
  toolsSeq.set(hostId, (toolsSeq.get(hostId) ?? 0) + 1)
  updateHostGit(hostId, (h) => ({
    tools,
    toolsError: null,
    stackUnavailable: clearAuthStackFallbacks(hostId, h, tools),
  }))
}

export function loadGitTools(hostId: string | null = null): Promise<void> {
  const pending = toolsInFlight.get(hostId)
  if (pending) return pending
  const seq = (toolsSeq.get(hostId) ?? 0) + 1
  toolsSeq.set(hostId, seq)
  updateHostGit(hostId, () => ({ toolsError: null }))
  const run: Promise<void> = hostAt(hostId, 'git.tools', undefined)
    .then(
      (tools) => {
        if (toolsSeq.get(hostId) === seq) {
          updateHostGit(hostId, (h) => ({
            tools,
            toolsError: null,
            stackUnavailable: clearAuthStackFallbacks(hostId, h, tools),
          }))
        }
      },
      (error: unknown) => {
        if (toolsSeq.get(hostId) === seq) {
          updateHostGit(hostId, () => ({ tools: null, toolsError: errorMessage(error) }))
        }
      },
    )
    .finally(() => {
      if (toolsInFlight.get(hostId) === run) toolsInFlight.delete(hostId)
    })
  toolsInFlight.set(hostId, run)
  return run
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
  receivePullRequest(pr, pr.url, hostOfPath(projectPath))
  return pr
}

/** Reads the project's repository and pull request again, as opening the popover or pane does. */
export function refreshGitProject(projectPath: string): void {
  void host('git.status', { projectPath }).then(receiveGitStatus, () => {})
  void host('git.currentPullRequest', { projectPath }).then(
    (current) => receiveCurrentPr(projectPath, current),
    () => {},
  )
  const hostId = hostOfPath(projectPath)
  if (!gitToolsOf(useGitStore.getState(), hostId)) void loadGitTools(hostId)
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
  openers.delete(projectPath)
  useGitStore.setState((s) => ({ dialogs: without(s.dialogs, projectPath) }))
}
