import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubReference,
  GitStatus,
  GitTools,
  Issue,
  PullRequest,
  PullRequestStack,
} from '@shared/git'
import { onHost } from '@renderer/lib/host-paths'

// Avoid parsing the multi-megabyte icon bundle transitively pulled in by bootstrap.ts.
vi.mock(
  '@hugeicons/core-free-icons',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => (prop === '__esModule' ? true : prop === 'then' ? undefined : prop),
        has: (_target, prop) => prop !== 'then',
      },
    ),
)

const REMOTE_A = 'a'.repeat(32)
const REMOTE_B = 'b'.repeat(32)

const PR_URL = 'https://github.com/acme/private-repo/pull/42'
const ISSUE_URL = 'https://github.com/acme/private-repo/issues/99'
const PR_REF: GitHubReference = {
  kind: 'pull',
  owner: 'acme',
  repo: 'private-repo',
  number: 42,
  url: PR_URL,
}
const ISSUE_REF: GitHubReference = {
  kind: 'issue',
  owner: 'acme',
  repo: 'private-repo',
  number: 99,
  url: ISSUE_URL,
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    owner: 'acme',
    repo: 'private-repo',
    number: 42,
    title: 'Fix remote routing',
    url: PR_URL,
    state: 'open',
    head: 'feat/remote',
    base: 'main',
    author: { login: 'octocat', name: 'The Octocat', bot: false },
    createdAt: 1_000,
    updatedAt: 2_000,
    mergedAt: null,
    closedAt: null,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    review: null,
    mergeable: 'clean',
    checks: { state: 'passing', passed: 2, failed: 0, pending: 0, runs: [] },
    ...overrides,
  }
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    owner: 'acme',
    repo: 'private-repo',
    number: 99,
    title: 'Unify gh routing',
    url: ISSUE_URL,
    state: 'open',
    author: { login: 'octocat', name: 'The Octocat', bot: false },
    createdAt: 1_000,
    closedAt: null,
    comments: 4,
    labels: [],
    labelCount: 0,
    closedBy: null,
    ...overrides,
  }
}

function makeTools(state: GitTools['gh']['state'], account: string | null = null): GitTools {
  return {
    git: { found: true, version: '2.47.0' },
    gh: { state, version: state === 'not-installed' ? null : '2.62.0', account },
  }
}

function makeStatus(projectPath: string): GitStatus {
  return {
    projectPath,
    repo: { root: projectPath, gitDir: `${projectPath}/.git` },
    head: { branch: 'feat/remote', oid: '1234567', detached: false },
    defaultBranch: 'main',
    upstream: null,
    base: null,
    remote: null,
    push: null,
    changes: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      insertions: 0,
      deletions: 0,
    },
    commits: [],
    operation: null,
    lastFetchedAt: null,
    updatedAt: 1_000,
    stale: false,
  }
}

interface MockEnv {
  localRequest: ReturnType<typeof vi.fn>
  remoteRequest: ReturnType<typeof vi.fn>
  avatarLoad: ReturnType<typeof vi.fn>
  setVisibility: (state: 'visible' | 'hidden') => void
}

function stubGlobals(): MockEnv {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  let visibilityState: 'visible' | 'hidden' = 'visible'
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibilityState
    },
  })
  const never = new Promise(() => {})
  const localRequest = vi.fn(() => never)
  const remoteRequest = vi.fn(() => never)
  const avatarLoad = vi.fn()
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    kettu: {
      platform: 'darwin',
      client: 'desktop',
      hostPlatform: () => 'darwin',
      agents: {
        request: localRequest,
        onEvent: () => () => {},
        onConnection: () => () => {},
      },
      hosts: {
        request: remoteRequest,
        onChanged: () => () => {},
        onSession: () => () => {},
        status: vi.fn(() => never),
      },
      avatars: {
        load: avatarLoad,
      },
      settings: {
        get: vi.fn(() => never),
        update: vi.fn(() => never),
        onChanged: () => () => {},
      },
      marketplace: {
        setKeys: vi.fn(() => never),
        setAgentEnv: vi.fn(() => never),
      },
      remote: {
        status: vi.fn(() => never),
        onChanged: () => () => {},
      },
      sharing: {
        status: vi.fn(() => never),
        onChanged: () => () => {},
      },
    },
  })
  return {
    localRequest,
    remoteRequest,
    avatarLoad,
    setVisibility: (state) => {
      visibilityState = state
    },
  }
}

async function flushAsync(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

async function setupGitOnly() {
  vi.resetModules()
  const env = stubGlobals()
  const git = await import('./git')
  return { env, git }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('host-scoped GitHub gh routing in git store (#2699)', () => {
  it('routes loadPullRequest, loadReference (issue), loadAvatar, and loadGitTools to local vs remote host', async () => {
    const { env, git } = await setupGitOnly()
    const localPr = makePr({ title: 'Local PR' })
    const remotePr = makePr({ title: 'Remote Private PR' })
    const localIssue = makeIssue({ title: 'Local Issue' })
    const remoteIssue = makeIssue({ title: 'Remote Issue' })
    const localTools = makeTools('not-installed')
    const remoteTools = makeTools('ready', 'remote-dev')

    env.localRequest.mockImplementation(async (method: string) => {
      if (method === 'git.pullRequest') return localPr
      if (method === 'git.issue') return { kind: 'issue', issue: localIssue }
      if (method === 'git.avatarUrl') return 'https://avatars.githubusercontent.com/u/1'
      if (method === 'git.tools') return localTools
      return undefined
    })
    env.remoteRequest.mockImplementation(async (_hostId: string, method: string) => {
      if (method === 'git.pullRequest') return remotePr
      if (method === 'git.issue') return { kind: 'issue', issue: remoteIssue }
      if (method === 'git.avatarUrl') return 'https://avatars.githubusercontent.com/u/2'
      if (method === 'git.tools') return remoteTools
      return undefined
    })
    env.avatarLoad.mockImplementation(async (url: string) => `data:image/png;base64,${url}`)

    // Pull requests
    expect(await git.loadPullRequest(PR_URL, false, null)).toEqual(localPr)
    expect(await git.loadPullRequest(PR_URL, false, REMOTE_A)).toEqual(remotePr)
    expect(env.localRequest).toHaveBeenCalledWith('git.pullRequest', { url: PR_URL })
    expect(env.remoteRequest).toHaveBeenCalledWith(REMOTE_A, 'git.pullRequest', { url: PR_URL })

    // Issues
    git.loadReference(ISSUE_REF, false, null)
    git.loadReference(ISSUE_REF, false, REMOTE_A)
    await flushAsync()
    expect(git.issueOf(git.useGitStore.getState(), null, ISSUE_URL)).toEqual(localIssue)
    expect(git.issueOf(git.useGitStore.getState(), REMOTE_A, ISSUE_URL)).toEqual(remoteIssue)
    expect(env.localRequest).toHaveBeenCalledWith('git.issue', { url: ISSUE_URL })
    expect(env.remoteRequest).toHaveBeenCalledWith(REMOTE_A, 'git.issue', { url: ISSUE_URL })

    // Avatars
    git.loadAvatar('octocat', null)
    git.loadAvatar('octocat', REMOTE_A)
    await flushAsync()
    expect(git.avatarOf(git.useGitStore.getState(), null, 'octocat')).toBe(
      'data:image/png;base64,https://avatars.githubusercontent.com/u/1',
    )
    expect(git.avatarOf(git.useGitStore.getState(), REMOTE_A, 'octocat')).toBe(
      'data:image/png;base64,https://avatars.githubusercontent.com/u/2',
    )
    expect(env.localRequest).toHaveBeenCalledWith('git.avatarUrl', { login: 'octocat' })
    expect(env.remoteRequest).toHaveBeenCalledWith(REMOTE_A, 'git.avatarUrl', { login: 'octocat' })

    // Git tools
    await Promise.all([git.loadGitTools(null), git.loadGitTools(REMOTE_A)])
    const state = git.useGitStore.getState()
    expect(git.ghStateOf(state, null)).toBe('not-installed')
    expect(git.ghStateOf(state, REMOTE_A)).toBe('ready')
    expect(git.gitToolsOf(state, REMOTE_A)?.gh.account).toBe('remote-dev')
    expect(env.localRequest).toHaveBeenCalledWith('git.tools', undefined)
    expect(env.remoteRequest).toHaveBeenCalledWith(REMOTE_A, 'git.tools', undefined)
  })

  it('isolates reference errors, PR caches, and issue-to-PR aliases across hosts', async () => {
    const { env, git } = await setupGitOnly()
    const remoteAPr = makePr({ title: 'Secret PR on A', state: 'merged', mergedAt: 3_000 })
    const remoteBPr = makePr({ title: 'Open PR on B', state: 'open' })

    env.localRequest.mockImplementation(async (method: string) => {
      if (method === 'git.pullRequest') throw new Error('gh not installed')
      if (method === 'git.issue') throw new Error('HTTP 404')
      if (method === 'git.tools') return makeTools('not-installed')
      return undefined
    })
    env.remoteRequest.mockImplementation(async (hostId: string, method: string) => {
      if (method === 'git.pullRequest') {
        return hostId === REMOTE_A ? remoteAPr : remoteBPr
      }
      if (method === 'git.issue') {
        if (hostId === REMOTE_A) {
          return { kind: 'pull', pullRequest: makePr({ url: PR_URL, title: 'Aliased PR on A' }) }
        }
        return { kind: 'issue', issue: makeIssue({ title: 'Plain issue on B' }) }
      }
      if (method === 'git.tools') return makeTools('ready')
      return undefined
    })

    // Local failure does not block or pollute remote hosts for the same URL.
    expect(await git.loadPullRequest(PR_URL, false, null)).toBeNull()
    expect(await git.loadPullRequest(PR_URL, false, REMOTE_A)).toEqual(remoteAPr)
    expect(await git.loadPullRequest(PR_URL, false, REMOTE_B)).toEqual(remoteBPr)

    const s1 = git.useGitStore.getState()
    expect(git.pullRequestOf(s1, null, PR_URL)).toBeUndefined()
    expect(git.referenceErrorOf(s1, null, PR_URL)).toBe('gh not installed')
    expect(git.pullRequestOf(s1, REMOTE_A, PR_URL)?.title).toBe('Secret PR on A')
    expect(git.referenceErrorOf(s1, REMOTE_A, PR_URL)).toBeNull()
    expect(git.pullRequestOf(s1, REMOTE_B, PR_URL)?.title).toBe('Open PR on B')
    expect(git.isReferenceSettled(s1, PR_REF, REMOTE_A)).toBe(true)
    expect(git.isReferenceSettled(s1, PR_REF, REMOTE_B)).toBe(false)

    // Same issue URL resolves to a PR alias on REMOTE_A and an issue on REMOTE_B.
    await Promise.all([
      git.retryReference(ISSUE_REF, REMOTE_A),
      git.retryReference(ISSUE_REF, REMOTE_B),
    ])
    const s2 = git.useGitStore.getState()
    expect(git.pullRequestOf(s2, REMOTE_A, ISSUE_URL)?.title).toBe('Aliased PR on A')
    expect(git.issueOf(s2, REMOTE_A, ISSUE_URL)).toBeUndefined()
    expect(git.pullRequestOf(s2, REMOTE_B, ISSUE_URL)).toBeUndefined()
    expect(git.issueOf(s2, REMOTE_B, ISSUE_URL)?.title).toBe('Plain issue on B')
  })

  it('routes git.watchReferences per host and cleans up watches on host switch, visibility change, failure, and reconnect', async () => {
    vi.useFakeTimers()
    const { env, git } = await setupGitOnly()
    env.localRequest.mockResolvedValue(undefined)
    env.remoteRequest.mockResolvedValue(undefined)

    const localUrl = 'https://github.com/local/repo/pull/1'
    const remoteAUrl = 'https://github.com/remote-a/repo/pull/2'
    const remoteBUrl = 'https://github.com/remote-b/repo/pull/3'

    // Watch a remote-A reference while viewing a remote session.
    const releaseA = git.watchReference(remoteAUrl, REMOTE_A)
    await vi.advanceTimersByTimeAsync(300)
    expect(env.localRequest).not.toHaveBeenCalled()
    expect(env.remoteRequest).toHaveBeenCalledTimes(1)
    expect(env.remoteRequest).toHaveBeenLastCalledWith(REMOTE_A, 'git.watchReferences', {
      urls: [remoteAUrl],
    })

    // Switch from remote-A session to a local + remote-B session: remote-A unsubscribes.
    releaseA()
    // Calling release twice is a no-op and never underflows counts.
    releaseA()
    const releaseLocal = git.watchReference(localUrl, null)
    const releaseB = git.watchReference(remoteBUrl, REMOTE_B)
    await vi.advanceTimersByTimeAsync(300)

    expect(env.remoteRequest).toHaveBeenCalledWith(REMOTE_A, 'git.watchReferences', { urls: [] })
    expect(env.localRequest).toHaveBeenCalledWith('git.watchReferences', { urls: [localUrl] })
    expect(env.remoteRequest).toHaveBeenCalledWith(REMOTE_B, 'git.watchReferences', {
      urls: [remoteBUrl],
    })

    // Window hidden pauses watches on all active hosts; visible resumes them.
    env.localRequest.mockClear()
    env.remoteRequest.mockClear()
    env.setVisibility('hidden')
    git.syncReferences(true)
    expect(env.localRequest).toHaveBeenCalledWith('git.watchReferences', { urls: [] })
    expect(env.remoteRequest).toHaveBeenCalledWith(REMOTE_B, 'git.watchReferences', { urls: [] })

    env.localRequest.mockClear()
    env.remoteRequest.mockClear()
    env.setVisibility('visible')
    git.syncReferences(true)
    expect(env.localRequest).toHaveBeenCalledWith('git.watchReferences', { urls: [localUrl] })
    expect(env.remoteRequest).toHaveBeenCalledWith(REMOTE_B, 'git.watchReferences', {
      urls: [remoteBUrl],
    })

    // Remote disconnect clears sent tracking; reconnect re-subscribes only that host.
    env.localRequest.mockClear()
    env.remoteRequest.mockClear()
    git.gitHostClosed(REMOTE_B)
    git.rewatchGit(REMOTE_B)
    expect(env.localRequest).not.toHaveBeenCalled()
    expect(env.remoteRequest).toHaveBeenCalledWith(REMOTE_B, 'git.watchReferences', {
      urls: [remoteBUrl],
    })

    // If sending watchReferences fails (e.g. host briefly offline), a later sync retries it.
    env.remoteRequest.mockClear()
    env.remoteRequest.mockRejectedValueOnce(new Error('host offline'))
    git.syncReferences(true, REMOTE_B)
    await flushAsync()
    env.remoteRequest.mockResolvedValue(undefined)
    git.syncReferences(false, REMOTE_B)
    expect(env.remoteRequest).toHaveBeenCalledTimes(2)
    expect(env.remoteRequest).toHaveBeenLastCalledWith(REMOTE_B, 'git.watchReferences', {
      urls: [remoteBUrl],
    })

    releaseLocal()
    releaseB()
    await vi.advanceTimersByTimeAsync(300)
    expect(env.localRequest).toHaveBeenCalledWith('git.watchReferences', { urls: [] })
    expect(env.remoteRequest).toHaveBeenCalledWith(REMOTE_B, 'git.watchReferences', { urls: [] })
  })

  it('scopes bootstrap git.tools/git.reference events, HostScope tools, refreshGitProject, createPullRequest, and forgetHostGit', async () => {
    vi.resetModules()
    const env = stubGlobals()
    const git = await import('./git')
    const hostScope = await import('./host-scope')
    const bootstrap = await import('@renderer/app/bootstrap')
    const never = new Promise(() => {})

    env.localRequest.mockImplementation((method: string) => {
      if (method === 'git.tools') return Promise.resolve(makeTools('not-installed'))
      return never
    })
    env.remoteRequest.mockImplementation((_hostId: string, method: string, params?: unknown) => {
      if (method === 'git.tools') return Promise.resolve(makeTools('ready', 'remote-user'))
      if (method === 'git.status') {
        const projectPath = (params as { projectPath: string }).projectPath
        return Promise.resolve(makeStatus(projectPath))
      }
      if (method === 'git.currentPullRequest') return Promise.resolve(null)
      if (method === 'git.createPullRequest') {
        return Promise.resolve(makePr({ title: 'Created on remote' }))
      }
      return never
    })

    // Local tools loaded as not-installed; refreshing a remote project still loads remote tools.
    await git.loadGitTools(null)
    const remoteProject = onHost(REMOTE_A, '/work/repo')
    git.refreshGitProject(remoteProject)
    await flushAsync()
    expect(git.ghStateOf(git.useGitStore.getState(), REMOTE_A)).toBe('ready')
    expect(git.ghStateOf(git.useGitStore.getState(), null)).toBe('not-installed')

    // HostScope.useGitStore reads the same per-host state in useGitStore.
    expect(hostScope.LOCAL_SCOPE.useGitStore.getState().tools?.gh.state).toBe('not-installed')
    expect(hostScope.hostScope(REMOTE_A).useGitStore.getState().tools?.gh.state).toBe('ready')

    // Remote push events update only that host's slice.
    const updatedPr = makePr({ title: 'Pushed from remote', state: 'merged', mergedAt: 5_000 })
    bootstrap.onHostEvent(
      { type: 'git.reference', url: PR_URL, found: { kind: 'pull', pullRequest: updatedPr } },
      REMOTE_A,
    )
    bootstrap.onHostEvent({ type: 'git.tools', tools: makeTools('signed-out') }, REMOTE_A)

    const afterEvents = git.useGitStore.getState()
    expect(git.pullRequestOf(afterEvents, REMOTE_A, PR_URL)?.title).toBe('Pushed from remote')
    expect(git.pullRequestOf(afterEvents, null, PR_URL)).toBeUndefined()
    expect(git.ghStateOf(afterEvents, REMOTE_A)).toBe('signed-out')
    expect(hostScope.hostScope(REMOTE_A).useGitStore.getState().tools?.gh.state).toBe('signed-out')
    expect(git.ghStateOf(afterEvents, null)).toBe('not-installed')

    // createPullRequest caches the PR under the project's host.
    await git.createPullRequest(remoteProject, {
      title: 'Created on remote',
      body: '',
      base: 'main',
      draft: false,
    })
    expect(git.pullRequestOf(git.useGitStore.getState(), REMOTE_A, PR_URL)?.title).toBe(
      'Created on remote',
    )
    expect(git.pullRequestOf(git.useGitStore.getState(), null, PR_URL)).toBeUndefined()

    // Forgetting a removed host clears only its cached slice.
    git.forgetHostGit(REMOTE_A)
    const afterForget = git.useGitStore.getState()
    expect(git.pullRequestOf(afterForget, REMOTE_A, PR_URL)).toBeUndefined()
    expect(git.ghStateOf(afterForget, REMOTE_A)).toBeNull()
    expect(git.ghStateOf(afterForget, null)).toBe('not-installed')
  }, 15_000)

  it('loads, isolates, settles, retries, and gracefully degrades GitHub stacks per host (#2844)', async () => {
    const { env, git } = await setupGitOnly()
    const STACK_URL = 'https://github.com/acme/private-repo/stacks/7'
    const STACK_REF: GitHubReference = {
      kind: 'stack',
      owner: 'acme',
      repo: 'private-repo',
      number: 7,
      url: STACK_URL,
    }
    const openStack: PullRequestStack = {
      url: STACK_URL,
      owner: 'acme',
      repo: 'private-repo',
      number: 7,
      title: 'Auth stack',
      state: 'open',
      base: 'main',
      createdAt: 1_000,
      updatedAt: 2_000,
      pullRequests: [
        {
          number: 11,
          url: 'https://github.com/acme/private-repo/pull/11',
          state: 'open',
          head: 'feat/auth-1',
          title: null,
        },
      ],
    }

    env.localRequest.mockImplementation(async (method: string) => {
      if (method === 'git.stack') throw new Error('Unknown method: git.stack')
      if (method === 'git.tools') return makeTools('ready', 'local-dev')
      return undefined
    })
    env.remoteRequest.mockImplementation(
      async (hostId: string, method: string, params?: unknown) => {
        if (method === 'git.stack') {
          if (hostId === REMOTE_A) return { kind: 'stack', stack: openStack }
          const fresh = (params as { fresh?: boolean } | undefined)?.fresh
          return fresh
            ? { kind: 'stack', stack: { ...openStack, state: 'closed' } }
            : { kind: 'unavailable', reason: 'not-found' }
        }
        if (method === 'git.tools') return makeTools('ready', 'remote-dev')
        return undefined
      },
    )

    // Local RPC error degrades cleanly to stackUnavailable without populating referenceErrors.
    git.loadReference(STACK_REF, false, null)
    git.loadReference(STACK_REF, false, REMOTE_A)
    git.loadReference(STACK_REF, false, REMOTE_B)
    await flushAsync()

    const s1 = git.useGitStore.getState()
    expect(git.stackOf(s1, null, STACK_URL)).toBeUndefined()
    expect(git.stackUnavailableOf(s1, null, STACK_URL)).toBe('unavailable')
    expect(git.referenceErrorOf(s1, null, STACK_URL)).toBeNull()

    expect(git.stackOf(s1, REMOTE_A, STACK_URL)).toEqual(openStack)
    expect(git.isReferenceSettled(s1, STACK_REF, REMOTE_A)).toBe(false)

    expect(git.stackOf(s1, REMOTE_B, STACK_URL)).toBeUndefined()
    expect(git.stackUnavailableOf(s1, REMOTE_B, STACK_URL)).toBe('not-found')
    expect(git.isReferenceSettled(s1, STACK_REF, REMOTE_B)).toBe(true)

    // Explicit retry sends fresh: true and updates cached stack state.
    await git.retryReference(STACK_REF, REMOTE_B)
    const s2 = git.useGitStore.getState()
    expect(env.remoteRequest).toHaveBeenLastCalledWith(REMOTE_B, 'git.stack', {
      url: STACK_URL,
      fresh: true,
    })
    expect(git.stackOf(s2, REMOTE_B, STACK_URL)?.state).toBe('closed')
    expect(git.stackUnavailableOf(s2, REMOTE_B, STACK_URL)).toBeNull()
    expect(git.isReferenceSettled(s2, STACK_REF, REMOTE_B)).toBe(true)

    // Signing in to gh clears prior auth-related stack fallbacks.
    git.receiveReference(STACK_URL, { kind: 'unavailable', reason: 'gh-signed-out' }, REMOTE_A)
    git.receiveGitTools(REMOTE_A, makeTools('ready', 'remote-dev'))
    expect(git.stackUnavailableOf(git.useGitStore.getState(), REMOTE_A, STACK_URL)).toBeNull()
  })
})
