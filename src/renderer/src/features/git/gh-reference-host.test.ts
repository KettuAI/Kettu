import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import type {
  GitHubReference,
  GitStatus,
  GitTools,
  PullRequest,
  PullRequestStack,
} from '@shared/git'
import { onHost } from '@renderer/lib/host-paths'

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
vi.mock('@hugeicons/react', () => ({ HugeiconsIcon: () => null }))

vi.mock('@renderer/lib/use-now', () => ({
  useNow: () => 60_000,
}))

// In renderToStaticMarkup (SSR), React reads Zustand's getInitialState instead of live getState.
// Wrap zustand's `create` so selector reads during static markup reflect current store state.
vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand')>()
  const make = <T>(initializer: StateCreator<T, [], []>) => {
    const api = actual.createStore(initializer)
    const read = <U = T>(selector?: (state: T) => U): U =>
      selector ? selector(api.getState()) : (api.getState() as unknown as U)
    return Object.assign(read, api)
  }
  const create = <T>(initializer?: StateCreator<T, [], []>) =>
    initializer ? make(initializer) : (fn: StateCreator<T, [], []>) => make(fn)
  return { ...actual, create }
})

const REMOTE_A = 'a'.repeat(32)
const REMOTE_B = 'b'.repeat(32)
const PR_URL = 'https://github.com/acme/app/pull/7'
const PR_REF: GitHubReference = {
  kind: 'pull',
  owner: 'acme',
  repo: 'app',
  number: 7,
  url: PR_URL,
}

function makeTools(state: GitTools['gh']['state'], account: string | null = null): GitTools {
  return {
    git: { found: true, version: '2.47.0' },
    gh: { state, version: state === 'not-installed' ? null : '2.62.0', account },
  }
}

function makePr(title: string): PullRequest {
  return {
    owner: 'acme',
    repo: 'app',
    number: 7,
    title,
    url: PR_URL,
    state: 'open',
    head: 'feat/test',
    base: 'main',
    author: { login: 'octocat', name: 'The Octocat', bot: false },
    createdAt: 1_000,
    updatedAt: 2_000,
    mergedAt: null,
    closedAt: null,
    additions: 5,
    deletions: 1,
    changedFiles: 2,
    review: null,
    mergeable: 'clean',
    checks: { state: 'passing', passed: 1, failed: 0, pending: 0, runs: [] },
  }
}

function makeStatus(projectPath: string): GitStatus {
  return {
    projectPath,
    repo: { root: projectPath, gitDir: `${projectPath}/.git` },
    head: { branch: 'feat/test', oid: '1234567', detached: false },
    defaultBranch: 'main',
    upstream: { name: 'origin/feat/test', ahead: 0, behind: 0 },
    base: null,
    remote: {
      name: 'origin',
      url: 'https://github.com/acme/app.git',
      github: { owner: 'acme', repo: 'app' },
    },
    push: {
      kind: 'remote',
      remote: 'origin',
      github: { owner: 'acme', repo: 'app' },
      branch: 'feat/test',
      setUpstream: false,
    },
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

function stubGlobals() {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  const never = new Promise(() => {})
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    kettu: {
      platform: 'darwin',
      client: 'desktop',
      hostPlatform: () => 'darwin',
      agents: {
        request: vi.fn(() => never),
        onEvent: () => () => {},
        onConnection: () => () => {},
      },
      hosts: {
        request: vi.fn(() => never),
        onChanged: () => () => {},
        onSession: () => () => {},
        status: vi.fn(() => never),
      },
      avatars: { load: vi.fn(() => never) },
      settings: { get: vi.fn(() => never), update: vi.fn(() => never), onChanged: () => () => {} },
      marketplace: { setKeys: vi.fn(() => never), setAgentEnv: vi.fn(() => never) },
      remote: { status: vi.fn(() => never), onChanged: () => () => {} },
      sharing: { status: vi.fn(() => never), onChanged: () => () => {} },
    },
  })
}

async function loadUiModules() {
  vi.resetModules()
  stubGlobals()
  const gitStore = await import('@renderer/stores/git')
  const host = await import('@renderer/lib/host')
  const hostScope = await import('@renderer/stores/host-scope')
  const fileRefs = await import('@renderer/features/files/file-refs')
  const grants = await import('@renderer/features/session/media/grants')
  const refData = await import('./gh-reference-data')
  const ghRef = await import('./gh-reference')
  const prPart = await import('./pr-part')
  return { gitStore, host, hostScope, fileRefs, grants, refData, ghRef, prPart }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHub UI components and hooks use the target host state (#2699)', () => {
  it('resolves useGitHostId from explicit prop, GitHostContext, ProjectPathContext, PreviewFileContext, SessionIdContext, and HostScopeContext', async () => {
    const { host, hostScope, fileRefs, grants, refData } = await loadUiModules()
    host.learnSessionHosts(REMOTE_B, ['sess-remote-b'])

    function Probe({ explicit }: { explicit?: string | null }) {
      return createElement('span', null, refData.useGitHostId(explicit) ?? 'local')
    }

    // Default (no context) -> local
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<span>local</span>')

    // ProjectPathContext -> remote host
    expect(
      renderToStaticMarkup(
        createElement(
          fileRefs.ProjectPathContext,
          { value: onHost(REMOTE_A, '/work/app') },
          createElement(Probe),
        ),
      ),
    ).toBe(`<span>${REMOTE_A}</span>`)

    // PreviewFileContext -> remote host
    expect(
      renderToStaticMarkup(
        createElement(
          fileRefs.PreviewFileContext,
          { value: { projectPath: onHost(REMOTE_A, '/work/app'), path: 'README.md' } },
          createElement(Probe),
        ),
      ),
    ).toBe(`<span>${REMOTE_A}</span>`)

    // SessionIdContext -> session's remote host
    expect(
      renderToStaticMarkup(
        createElement(grants.SessionIdContext, { value: 'sess-remote-b' }, createElement(Probe)),
      ),
    ).toBe(`<span>${REMOTE_B}</span>`)

    // HostScopeContext -> scope's remote host
    expect(
      renderToStaticMarkup(
        createElement(
          hostScope.HostScopeContext.Provider,
          { value: hostScope.hostScope(REMOTE_A) },
          createElement(Probe),
        ),
      ),
    ).toBe(`<span>${REMOTE_A}</span>`)

    // GitHostContext overrides ProjectPathContext, and explicit prop overrides GitHostContext.
    expect(
      renderToStaticMarkup(
        createElement(
          fileRefs.ProjectPathContext,
          { value: '/local/app' },
          createElement(
            refData.GitHostContext,
            { value: REMOTE_A },
            createElement(Probe),
            createElement(Probe, { explicit: null }),
          ),
        ),
      ),
    ).toBe(`<span>${REMOTE_A}</span><span>local</span>`)
  }, 15_000)

  it('renders remote ReferenceCard and PullRequestPart using remote gh state even when local gh is missing', async () => {
    const { gitStore, fileRefs, ghRef, prPart } = await loadUiModules()

    // Local machine has no gh installed; remote host A is signed in and has PR details cached.
    gitStore.receiveGitTools(null, makeTools('not-installed'))
    gitStore.receiveGitTools(REMOTE_A, makeTools('ready', 'remote-dev'))
    gitStore.receiveReference(
      PR_URL,
      { kind: 'pull', pullRequest: makePr('Remote PR Title') },
      REMOTE_A,
    )

    // Local ReferenceCard sees local gh missing (shows install prompt) and does not leak remote PR.
    const localCard = renderToStaticMarkup(
      createElement(
        fileRefs.ProjectPathContext,
        { value: '/local/repo' },
        createElement(ghRef.ReferenceCard, { reference: PR_REF }),
      ),
    )
    expect(localCard).toContain('https://cli.github.com')
    expect(localCard).not.toContain('Remote PR Title')

    // Remote ReferenceCard sees remote PR details and does not show local install prompt.
    const remoteCard = renderToStaticMarkup(
      createElement(
        fileRefs.ProjectPathContext,
        { value: onHost(REMOTE_A, '/remote/repo') },
        createElement(ghRef.ReferenceCard, { reference: PR_REF }),
      ),
    )
    expect(remoteCard).toContain('Remote PR Title')
    expect(remoteCard).not.toContain('https://cli.github.com')

    // Explicit hostId also isolates remote state outside ProjectPathContext (e.g. sidebar hover cards).
    const explicitRemoteCard = renderToStaticMarkup(
      createElement(ghRef.ReferenceCard, { reference: PR_REF, hostId: REMOTE_A }),
    )
    expect(explicitRemoteCard).toContain('Remote PR Title')

    // PullRequestPart for a remote project with ready remote gh renders nothing (not local install warning).
    const remotePartReady = renderToStaticMarkup(
      createElement(prPart.PullRequestPart, {
        status: makeStatus(onHost(REMOTE_A, '/remote/repo')),
        pr: null,
        onClose: () => {},
        onFix: () => {},
      }),
    )
    expect(remotePartReady).toBe('')

    // PullRequestPart for a remote project whose remote gh is signed out shows remote gh auth login,
    // even if local gh is ready.
    gitStore.receiveGitTools(null, makeTools('ready', 'local-dev'))
    gitStore.receiveGitTools(REMOTE_B, makeTools('signed-out'))
    const remotePartSignedOut = renderToStaticMarkup(
      createElement(prPart.PullRequestPart, {
        status: makeStatus(onHost(REMOTE_B, '/remote/repo')),
        pr: null,
        onClose: () => {},
        onFix: () => {},
      }),
    )
    expect(remotePartSignedOut).toContain('gh auth login')
  }, 15_000)
})

describe('GitHub stacked pull requests reference chip and hover card (#2844)', () => {
  const STACK_URL = 'https://github.com/acme/app/stacks/42'
  const STACK_REF: GitHubReference = {
    kind: 'stack',
    owner: 'acme',
    repo: 'app',
    number: 42,
    url: STACK_URL,
  }

  function makeStack(overrides: Partial<PullRequestStack> = {}): PullRequestStack {
    return {
      url: STACK_URL,
      owner: 'acme',
      repo: 'app',
      number: 42,
      title: null,
      state: 'open',
      base: 'main',
      createdAt: 1_000,
      updatedAt: 2_000,
      pullRequests: [
        {
          number: 101,
          url: 'https://github.com/acme/app/pull/101',
          state: 'merged',
          head: 'feat/model',
          title: null,
        },
        {
          number: 102,
          url: 'https://github.com/acme/app/pull/102',
          state: 'open',
          head: 'feat/api',
          title: 'Expose API',
        },
      ],
      ...overrides,
    }
  }

  it('renders stack chip text and hover card chain with clickable PR links and no target=_blank', async () => {
    const { gitStore, fileRefs, ghRef, refData } = await loadUiModules()
    gitStore.receiveGitTools(null, makeTools('ready', 'octocat'))
    gitStore.receiveGitStatus(makeStatus('/local/repo'))
    gitStore.receiveReference(STACK_URL, { kind: 'stack', stack: makeStack() }, null)

    expect(refData.shortReference(STACK_REF, { owner: 'acme', repo: 'app' })).toBe('Stack #42')
    expect(refData.shortReference(STACK_REF, { owner: 'other', repo: 'repo' })).toBe(
      'acme/app Stack #42',
    )

    const chipHtml = renderToStaticMarkup(
      createElement(
        fileRefs.ProjectPathContext,
        { value: '/local/repo' },
        createElement(ghRef.ReferenceText, {
          reference: STACK_REF,
          bare: true,
          children: STACK_URL,
        }),
      ),
    )
    expect(chipHtml).toContain('Stack #42')
    expect(chipHtml).toContain('2 PRs → main')

    const cardHtml = renderToStaticMarkup(
      createElement(ghRef.ReferenceCard, { reference: STACK_REF, sessionId: 'sess-1' }),
    )
    expect(cardHtml).toContain('Open')
    expect(cardHtml).toContain('acme/app · Stack #42')
    expect(cardHtml).toContain('→')
    expect(cardHtml).toContain('main')
    expect(cardHtml).toContain('#101')
    expect(cardHtml).toContain('feat/model')
    expect(cardHtml).toContain('#102')
    expect(cardHtml).toContain('Expose API')
    expect(cardHtml).toContain('href="https://github.com/acme/app/pull/101"')
    expect(cardHtml).toContain('href="https://github.com/acme/app/pull/102"')
    expect(cardHtml).toContain(`href="${STACK_URL}"`)
    expect(cardHtml).not.toContain('target="_blank"')
  }, 15_000)

  it('degrades cleanly on 404/403, signed-out gh, and timeout without raw error output', async () => {
    const { gitStore, ghRef } = await loadUiModules()
    gitStore.receiveGitTools(null, makeTools('ready', 'octocat'))

    gitStore.receiveReference(STACK_URL, { kind: 'unavailable', reason: 'not-found' }, null)
    const notFoundHtml = renderToStaticMarkup(
      createElement(ghRef.ReferenceCard, { reference: STACK_REF }),
    )
    expect(notFoundHtml).toContain('Stack #42')
    expect(notFoundHtml).toContain('Stack details aren&#x27;t available here')
    expect(notFoundHtml).not.toContain('HTTP 404')
    expect(notFoundHtml).not.toContain('Retry')

    gitStore.receiveReference(STACK_URL, { kind: 'unavailable', reason: 'timeout' }, null)
    const timeoutHtml = renderToStaticMarkup(
      createElement(ghRef.ReferenceCard, { reference: STACK_REF }),
    )
    expect(timeoutHtml).toContain('Couldn&#x27;t load stack details right now.')
    expect(timeoutHtml).toContain('Retry')

    gitStore.receiveReference(STACK_URL, { kind: 'unavailable', reason: 'gh-signed-out' }, null)
    const signedOutHtml = renderToStaticMarkup(
      createElement(ghRef.ReferenceCard, { reference: STACK_REF }),
    )
    expect(signedOutHtml).toContain('gh auth login')
  }, 15_000)
})
