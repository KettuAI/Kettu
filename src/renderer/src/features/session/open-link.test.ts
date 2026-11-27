import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import type { GitHubReference, GitStatus, Issue, PullRequest } from '@shared/git'
import type { TerminalInfo } from '@shared/terminal-host'

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
vi.mock('@renderer/lib/use-now', () => ({ useNow: () => 60_000, useSeconds: () => 60_000 }))

// Mirror live Zustand state during renderToStaticMarkup so SSR reads match store mutations.
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

const ROOT = path.resolve(import.meta.dirname, '../../..')
const readSource = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

const PR_URL = 'https://github.com/acme/app/pull/42'
const ISSUE_URL = 'https://github.com/acme/app/issues/99'
const CHECK_URL = 'https://github.com/acme/app/actions/runs/1234'
const LOCAL_URL = 'http://localhost:5173/dashboard'

function makeSummary(
  id: string,
  projectPath = '/work/acme',
  worktreePath?: string,
): SessionSummary {
  return {
    id,
    acpSessionId: null,
    parentId: null,
    origin: 'user',
    projectPath,
    agentId: 'claude-code',
    title: 'Test session',
    description: null,
    missing: false,
    cache: null,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
    pinnedAt: null,
    archivedAt: null,
    scratch: false,
    branch: 'feat/links',
    ...(worktreePath
      ? {
          worktree: {
            path: worktreePath,
            branch: 'feat/links',
            base: 'main',
            baseOid: '0123456',
            state: 'ready' as const,
          },
        }
      : {}),
    pr: null,
    prs: [],
    model: null,
    task: null,
    routine: null,
  }
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    owner: 'acme',
    repo: 'app',
    number: 42,
    title: 'Route session links consistently',
    url: PR_URL,
    state: 'open',
    head: 'feat/links',
    base: 'main',
    author: { login: 'octocat', name: 'Octocat', bot: false },
    createdAt: 1_000,
    updatedAt: 2_000,
    mergedAt: null,
    closedAt: null,
    additions: 12,
    deletions: 4,
    changedFiles: 3,
    review: null,
    mergeable: 'clean',
    checks: {
      state: 'failing',
      passed: 1,
      failed: 1,
      pending: 0,
      runs: [
        {
          name: 'unit-tests',
          outcome: 'failed',
          url: CHECK_URL,
          startedAt: 1_000,
          completedAt: 2_000,
        },
      ],
    },
    ...overrides,
  }
}

function makeIssue(): Issue {
  return {
    owner: 'acme',
    repo: 'app',
    number: 99,
    title: 'Links bypass session browser',
    url: ISSUE_URL,
    state: 'completed',
    author: { login: 'octocat', name: 'Octocat', bot: false },
    createdAt: 1_000,
    closedAt: 3_000,
    comments: 2,
    labels: [],
    labelCount: 0,
    closedBy: { url: PR_URL, number: 42, state: 'merged' },
  }
}

function makeStatus(projectPath = '/work/acme'): GitStatus {
  return {
    projectPath,
    repo: { root: projectPath, gitDir: `${projectPath}/.git` },
    head: { branch: 'feat/links', oid: 'abcdef1234567', detached: false },
    defaultBranch: 'main',
    upstream: { name: 'origin/feat/links', ahead: 0, behind: 0 },
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
      branch: 'feat/links',
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

function makeTerminal(id: string, overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id,
    projectPath: '/work/acme',
    sessionId: null,
    owner: null,
    shell: 'zsh',
    title: 'zsh',
    name: null,
    namedBy: null,
    createdAt: 1_000,
    busy: false,
    exitCode: null,
    agentAllowed: false,
    control: { kind: 'idle' },
    waiting: null,
    ...overrides,
  }
}

interface Env {
  windowOpen: ReturnType<typeof vi.fn>
  browserNavigate: ReturnType<typeof vi.fn>
  browserOpenLink: ReturnType<typeof vi.fn>
  siteOpened: ReturnType<typeof vi.fn>
  settingsUpdate: ReturnType<typeof vi.fn>
}

async function setupEnv(client: 'desktop' | 'web' = 'desktop') {
  vi.resetModules()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  })
  const windowOpen = vi.fn()
  const browserNavigate = vi.fn(() => Promise.resolve())
  const browserOpenLink = vi.fn(() => Promise.resolve())
  const siteOpened = vi.fn(() => Promise.resolve())
  const settingsUpdate = vi.fn(() => Promise.resolve({}))
  const never = new Promise(() => {})
  vi.stubGlobal('window', {
    open: windowOpen,
    matchMedia: () => ({ matches: false }),
    kettu: {
      platform: 'darwin',
      client,
      hostPlatform: () => 'darwin',
      app: {
        defaultBrowser: vi.fn(() => Promise.resolve({ name: 'Safari', icon: null })),
      },
      browser: {
        navigate: browserNavigate,
        openLink: browserOpenLink,
        siteOpened,
        siteIcons: vi.fn(() => Promise.resolve({})),
        loadSiteIcon: vi.fn(() => Promise.resolve()),
        onSiteIcon: () => () => {},
      },
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
      settings: {
        get: vi.fn(() => never),
        update: settingsUpdate,
        onChanged: () => () => {},
      },
      marketplace: { setKeys: vi.fn(() => never), setAgentEnv: vi.fn(() => never) },
      remote: { status: vi.fn(() => never), onChanged: () => () => {} },
      sharing: { status: vi.fn(() => never), onChanged: () => () => {} },
      terminals: {
        request: vi.fn(() => never),
        onEvent: () => () => {},
        onConnection: () => () => {},
      },
    },
  })

  const openLink = await import('./open-link')
  const sessionsStore = await import('@renderer/stores/sessions')
  const settingsStore = await import('@renderer/stores/settings')
  const siteIconsStore = await import('@renderer/stores/site-icons')
  const viewStore = await import('@renderer/stores/view')
  const gitStore = await import('@renderer/stores/git')
  const terminalsStore = await import('@renderer/stores/terminals')
  const xtermRegistry = await import('@renderer/features/terminal/xterm-registry')
  const gitSteps = await import('@renderer/features/git/steps')

  const env: Env = { windowOpen, browserNavigate, browserOpenLink, siteOpened, settingsUpdate }
  return {
    env,
    openLink,
    sessionsStore,
    settingsStore,
    siteIconsStore,
    viewStore,
    gitStore,
    terminalsStore,
    xtermRegistry,
    gitSteps,
  }
}

/** Finds all anchor React elements inside an element tree without touching DOM globals. */
function findAnchors(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const result: ReactElement<Record<string, unknown>>[] = []
  const visit = (current: ReactNode) => {
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (!isValidElement<Record<string, unknown>>(current)) return
    if (current.type === 'a') result.push(current)
    if (typeof current.type === 'function') {
      const fn = current.type as (props: Record<string, unknown>) => ReactNode
      visit(fn(current.props))
      return
    }
    if (current.props.children) visit(current.props.children as ReactNode)
  }
  visit(node)
  return result
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('session link routing helper (#2848)', () => {
  it('opens in the session browser and switches to the owning session when openLinksIn is session', async () => {
    const { env, openLink, sessionsStore, settingsStore, siteIconsStore, viewStore } =
      await setupEnv('desktop')

    sessionsStore.useSessionsStore.setState({
      byId: { 'sess-1': makeSummary('sess-1', '/work/acme') },
    })
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: { ...s.settings.thread, openLinksIn: 'session', confirmLinks: true },
      },
    }))
    siteIconsStore.useSiteIconsStore.setState({ sites: { 'https://github.com': null } })

    const handled = openLink.openSessionLink(PR_URL, 'sess-1')

    expect(handled).toBe(true)
    expect(viewStore.useViewStore.getState().main).toEqual({ kind: 'session', sessionId: 'sess-1' })
    expect(viewStore.useViewStore.getState().sidePane['sess-1']).toBe('browser')
    expect(env.browserOpenLink).toHaveBeenCalledWith('sess-1', PR_URL)
    expect(env.browserNavigate).not.toHaveBeenCalled()
    expect(env.windowOpen).not.toHaveBeenCalled()
    expect(openLink.useLinkConfirmStore.getState().request).toBeNull()
  })

  it('honors Mod-click alternate destination and middle-click default destination', async () => {
    const { env, openLink, sessionsStore, settingsStore, siteIconsStore } =
      await setupEnv('desktop')

    sessionsStore.useSessionsStore.setState({
      byId: { 'sess-1': makeSummary('sess-1') },
    })
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: { ...s.settings.thread, openLinksIn: 'session', confirmLinks: false },
      },
    }))
    siteIconsStore.useSiteIconsStore.setState({ sites: { 'https://github.com': null } })

    const onOpen = vi.fn()
    const props = openLink.sessionLinkProps(PR_URL, 'sess-1', { onOpen })

    // Mod-click toggles to the external browser (unchanged Cmd/Ctrl+click behavior).
    const preventMod = vi.fn()
    props.onClick({
      button: 0,
      metaKey: true,
      ctrlKey: false,
      defaultPrevented: false,
      preventDefault: preventMod,
    } as never)
    expect(preventMod).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(env.windowOpen).toHaveBeenCalledWith(PR_URL, '_blank', 'noreferrer')
    expect(env.browserOpenLink).not.toHaveBeenCalled()
    expect(env.browserNavigate).not.toHaveBeenCalled()

    // Middle-click opens at the default destination (session browser via openLink).
    const preventAux = vi.fn()
    props.onAuxClick({
      button: 1,
      defaultPrevented: false,
      preventDefault: preventAux,
    } as never)
    expect(preventAux).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(env.browserOpenLink).toHaveBeenCalledWith('sess-1', PR_URL)
    expect(env.browserNavigate).not.toHaveBeenCalled()

    // When default destination is external browser, Mod-click still flips to session browser via openLink.
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: { ...s.settings.thread, openLinksIn: 'browser', confirmLinks: false },
      },
    }))
    env.browserOpenLink.mockClear()
    env.windowOpen.mockClear()
    props.onClick({
      button: 0,
      metaKey: true,
      ctrlKey: false,
      defaultPrevented: false,
      preventDefault: vi.fn(),
    } as never)
    expect(env.browserOpenLink).toHaveBeenCalledWith('sess-1', PR_URL)
    expect(env.windowOpen).not.toHaveBeenCalled()
  })

  it('opens the global LinkConfirmHost store in ask mode and remembers site preferences on confirm', async () => {
    const { env, openLink, sessionsStore, settingsStore } = await setupEnv('desktop')

    sessionsStore.useSessionsStore.setState({
      byId: { 'sess-1': makeSummary('sess-1') },
    })
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: { ...s.settings.thread, openLinksIn: 'ask', confirmLinks: true, alwaysOpenIn: {} },
      },
    }))

    expect(openLink.openSessionLink(PR_URL, 'sess-1')).toBe(true)
    const req = openLink.useLinkConfirmStore.getState().request
    expect(req).toMatchObject({
      url: PR_URL,
      destination: 'browser',
      sessionId: 'sess-1',
      open: true,
    })
    expect(env.browserOpenLink).not.toHaveBeenCalled()
    expect(env.windowOpen).not.toHaveBeenCalled()

    // Confirming with remember=true updates alwaysOpenIn and opens in the chosen session browser.
    openLink.confirmLinkOpen('session', true)
    expect(env.browserOpenLink).toHaveBeenCalledWith('sess-1', PR_URL)
    expect(env.browserNavigate).not.toHaveBeenCalled()
    expect(env.settingsUpdate).toHaveBeenCalledWith({
      thread: { alwaysOpenIn: { 'github.com': 'session' } },
    })

    openLink.closeLinkConfirm()
    expect(openLink.useLinkConfirmStore.getState().request?.open).toBe(false)
  })

  it('respects per-host alwaysOpenIn rules and localhost-in-session-browser without asking', async () => {
    const { env, openLink, sessionsStore, settingsStore } = await setupEnv('desktop')

    sessionsStore.useSessionsStore.setState({
      byId: { 'sess-1': makeSummary('sess-1') },
    })
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: {
          ...s.settings.thread,
          openLinksIn: 'browser',
          confirmLinks: true,
          alwaysOpenIn: { 'github.com': 'session' },
        },
      },
    }))

    openLink.openSessionLink(PR_URL, 'sess-1')
    expect(env.browserOpenLink).toHaveBeenCalledWith('sess-1', PR_URL)
    expect(openLink.useLinkConfirmStore.getState().request).toBeNull()

    openLink.openSessionLink(LOCAL_URL, 'sess-1')
    expect(env.browserOpenLink).toHaveBeenCalledWith('sess-1', LOCAL_URL)
    expect(env.browserNavigate).not.toHaveBeenCalled()
    expect(openLink.useLinkConfirmStore.getState().request).toBeNull()
  })

  it('falls back to external browser on the web client even when openLinksIn is session', async () => {
    const { env, openLink, sessionsStore, settingsStore, siteIconsStore } = await setupEnv('web')

    sessionsStore.useSessionsStore.setState({
      byId: { 'sess-1': makeSummary('sess-1') },
    })
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: { ...s.settings.thread, openLinksIn: 'session', confirmLinks: false },
      },
    }))
    siteIconsStore.useSiteIconsStore.setState({ sites: { 'https://github.com': null } })

    openLink.openSessionLink(PR_URL, 'sess-1')
    openLink.openSessionLink(LOCAL_URL, 'sess-1')

    expect(env.browserOpenLink).not.toHaveBeenCalled()
    expect(env.browserNavigate).not.toHaveBeenCalled()
    expect(env.windowOpen).toHaveBeenNthCalledWith(1, PR_URL, '_blank', 'noreferrer')
    expect(env.windowOpen).toHaveBeenNthCalledWith(2, LOCAL_URL, '_blank', 'noreferrer')
  })
})

describe('terminal and git toast link routing (#2848)', () => {
  it('routes terminal Mod+Click URLs through session link routing with localhost in session browser', async () => {
    const {
      env,
      openLink,
      sessionsStore,
      settingsStore,
      siteIconsStore,
      terminalsStore,
      xtermRegistry,
    } = await setupEnv('desktop')

    sessionsStore.useSessionsStore.setState({
      byId: {
        'sess-term': makeSummary('sess-term'),
        'sess-owner': makeSummary('sess-owner'),
      },
    })
    terminalsStore.useTerminalsStore.setState({
      byId: {
        'term-1': {
          ...makeTerminal('term-1', { sessionId: 'sess-term' }),
          activity: false,
          stale: false,
          localUrl: null,
        },
        'term-owner': {
          ...makeTerminal('term-owner', {
            sessionId: null,
            owner: { sessionId: 'sess-owner', agentId: 'claude-code' },
          }),
          activity: false,
          stale: false,
          localUrl: null,
        },
        'term-new': {
          ...makeTerminal('term-new', { sessionId: null }),
          activity: false,
          stale: false,
          localUrl: null,
        },
      },
    })
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: { ...s.settings.thread, openLinksIn: 'browser', confirmLinks: true },
      },
    }))

    // Plain click without Mod is ignored.
    expect(
      xtermRegistry.openTerminalLink('term-1', { metaKey: false, ctrlKey: false }, LOCAL_URL),
    ).toBe(false)
    expect(env.browserOpenLink).not.toHaveBeenCalled()

    // Mod+Click on localhost opens directly in the terminal's session browser without asking.
    expect(
      xtermRegistry.openTerminalLink('term-1', { metaKey: true, ctrlKey: false }, LOCAL_URL),
    ).toBe(true)
    expect(env.browserOpenLink).toHaveBeenCalledWith('sess-term', LOCAL_URL)
    expect(openLink.useLinkConfirmStore.getState().request).toBeNull()

    // Mod+Click in session mode uses owner.sessionId when terminal.sessionId is absent.
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: { ...s.settings.thread, openLinksIn: 'session', confirmLinks: false },
      },
    }))
    siteIconsStore.useSiteIconsStore.setState({ sites: { 'https://github.com': null } })
    expect(
      xtermRegistry.openTerminalLink('term-owner', { metaKey: true, ctrlKey: false }, PR_URL),
    ).toBe(true)
    expect(env.browserOpenLink).toHaveBeenCalledWith('sess-owner', PR_URL)

    // Non-session terminal opens externally.
    expect(
      xtermRegistry.openTerminalLink('term-new', { metaKey: true, ctrlKey: false }, PR_URL),
    ).toBe(true)
    expect(env.windowOpen).toHaveBeenCalledWith(PR_URL, '_blank', 'noreferrer')

    // Ask mode opens global LinkConfirmHost with the terminal's sessionId.
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: { ...s.settings.thread, openLinksIn: 'ask', confirmLinks: true },
      },
    }))
    expect(
      xtermRegistry.openTerminalLink('term-1', { metaKey: true, ctrlKey: false }, PR_URL),
    ).toBe(true)
    expect(openLink.useLinkConfirmStore.getState().request).toMatchObject({
      url: PR_URL,
      sessionId: 'sess-term',
      open: true,
    })
  })

  it('routes showCreatedPr toast Open action through session link routing', async () => {
    const { env, sessionsStore, settingsStore, siteIconsStore, viewStore, gitStore, gitSteps } =
      await setupEnv('desktop')
    const toastMod = await import('@renderer/components/ui/toast')

    const summary = makeSummary('sess-wt', '/work/acme', '/work/acme/.worktrees/feat')
    sessionsStore.useSessionsStore.setState({ byId: { 'sess-wt': summary } })
    viewStore.openSession('sess-wt', '/work/acme')
    gitStore.useGitStore.setState({
      currentPr: { '/work/acme/.worktrees/feat': makePr() },
    })
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: { ...s.settings.thread, openLinksIn: 'session', confirmLinks: false },
      },
    }))
    siteIconsStore.useSiteIconsStore.setState({ sites: { 'https://github.com': null } })

    const toastSpy = vi.spyOn(toastMod, 'toast')
    gitSteps.showCreatedPr('/work/acme/.worktrees/feat', 42)
    const action = toastSpy.mock.calls[0]?.[1]
    expect(action).toBeDefined()
    action?.onClick()

    expect(env.browserOpenLink).toHaveBeenCalledWith('sess-wt', PR_URL)
    expect(env.browserNavigate).not.toHaveBeenCalled()
    expect(env.windowOpen).not.toHaveBeenCalled()
  })
})

describe('representative session UI call sites route clicks cleanly (#2848)', () => {
  it('routes CardOutputs ReferenceRow, Overview OutputChip, PrBarChip, and ReferenceCard links without target=_blank', async () => {
    const { env, openLink, sessionsStore, settingsStore, siteIconsStore, gitStore } =
      await setupEnv('desktop')

    const summary = makeSummary('sess-ui', '/work/acme')
    sessionsStore.useSessionsStore.setState({ byId: { 'sess-ui': summary } })
    settingsStore.useSettingsStore.setState((s) => ({
      settings: {
        ...s.settings,
        thread: { ...s.settings.thread, openLinksIn: 'session', confirmLinks: false },
      },
    }))
    siteIconsStore.useSiteIconsStore.setState({ sites: { 'https://github.com': null } })

    const pr = makePr()
    const issue = makeIssue()
    const issueRef: GitHubReference = {
      kind: 'issue',
      owner: 'acme',
      repo: 'app',
      number: 99,
      url: ISSUE_URL,
    }
    gitStore.useGitStore.setState({
      currentPr: { '/work/acme': pr },
    })
    gitStore.receiveReference(ISSUE_URL, { kind: 'issue', issue }, null)

    const { CardOutputs } = await import('@renderer/features/sidebar/card-outputs')
    const { OutputChip } = await import('@renderer/features/overview/parts')
    const { PrBarChip } = await import('@renderer/features/git/pr-bar-chip')
    const { Title } = await import('@renderer/features/git/gh-reference')
    const { PullRequestPart } = await import('@renderer/features/git/pr-part')
    const { PullRequestPage } = await import('@renderer/features/git/pane/pr-page')
    const { NextStepCard } = await import('@renderer/features/git/next-step-card')

    // 1. Sidebar ReferenceRow renders without target="_blank".
    const cardHtml = renderToStaticMarkup(
      createElement(CardOutputs, {
        summary,
        outputs: {
          artifacts: [],
          references: [PR_URL],
          reply: null,
          plan: null,
          turnMs: null,
          turnStartedAt: null,
        },
      }),
    )
    expect(cardHtml).toContain(`href="${PR_URL}"`)
    expect(cardHtml).not.toContain('target="_blank"')

    // 2. Overview OutputChip click routes to session browser.
    const outputTree = OutputChip({
      output: { kind: 'pr', url: PR_URL, number: 42, sessionId: 'sess-ui' },
    })
    const outputAnchors = findAnchors(outputTree)
    expect(outputAnchors).toHaveLength(1)
    expect(outputAnchors[0]!.props.target).toBeUndefined()
    const preventOutput = vi.fn()
    ;(outputAnchors[0]!.props.onClick as (event: unknown) => void)({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      preventDefault: preventOutput,
    })
    expect(preventOutput).toHaveBeenCalledTimes(1)
    expect(env.browserOpenLink).toHaveBeenCalledWith('sess-ui', PR_URL)
    expect(env.browserNavigate).not.toHaveBeenCalled()

    // 3. PrBarChip renders without target="_blank" and passes sessionId through.
    const chipHtml = renderToStaticMarkup(
      createElement(PrBarChip, { projectPath: '/work/acme', sessionId: 'sess-ui' }),
    )
    expect(chipHtml).toContain(`href="${PR_URL}"`)
    expect(chipHtml).not.toContain('target="_blank"')

    // 4. GitHub ReferenceCard Title and IssueDetails closedBy render without target="_blank".
    const { ReferenceCard } = await import('@renderer/features/git/gh-reference')
    const refHtml = renderToStaticMarkup(
      createElement(ReferenceCard, { reference: issueRef, sessionId: 'sess-ui' }),
    )
    expect(refHtml).toContain(`href="${ISSUE_URL}"`)
    expect(refHtml).toContain(`href="${PR_URL}"`)
    expect(refHtml).not.toContain('target="_blank"')

    // Direct Title click with explicit sessionId routes to session browser.
    const titleEl = createElement(Title, {
      url: ISSUE_URL,
      title: issue.title,
      sessionId: 'sess-ui',
    })
    const titleMarkup = renderToStaticMarkup(titleEl)
    expect(titleMarkup).toContain(`href="${ISSUE_URL}"`)
    expect(titleMarkup).not.toContain('target="_blank"')

    // 5. Git pane PullRequestPart, PullRequestPage, and NextStepCard render PR/check links without target="_blank".
    const status = makeStatus('/work/acme')
    const prPartHtml = renderToStaticMarkup(
      createElement(
        openLink.LinkSessionContext,
        { value: 'sess-ui' },
        createElement(PullRequestPart, {
          status,
          pr,
          onClose: () => {},
          onFix: () => {},
        }),
      ),
    )
    expect(prPartHtml).toContain(`href="${PR_URL}"`)
    expect(prPartHtml).toContain(`href="${CHECK_URL}"`)
    expect(prPartHtml).not.toContain('target="_blank"')

    const prPageHtml = renderToStaticMarkup(
      createElement(
        openLink.LinkSessionContext,
        { value: 'sess-ui' },
        createElement(PullRequestPage, {
          status,
          pr,
          gh: 'ready',
          panel: 'sess-ui',
          onHandOff: () => {},
        }),
      ),
    )
    expect(prPageHtml).toContain(`href="${PR_URL}"`)
    expect(prPageHtml).toContain(`href="${CHECK_URL}"`)
    expect(prPageHtml).not.toContain('target="_blank"')

    const nextStepHtml = renderToStaticMarkup(
      createElement(
        openLink.LinkSessionContext,
        { value: 'sess-ui' },
        createElement(NextStepCard, {
          status,
          pr: makePr({
            checks: { state: 'passing', passed: 1, failed: 0, pending: 0, runs: [] },
            review: 'approved',
          }),
          gh: 'ready',
          files: [],
          onClose: () => {},
          onHandOff: () => {},
          onOpenPane: () => {},
        }),
      ),
    )
    expect(nextStepHtml).toContain(`href="${PR_URL}"`)
    expect(nextStepHtml).not.toContain('target="_blank"')

    // 6. AIAnswer and ThinkingState omit target="_blank" inside LinkSessionContext,
    //    and preserve target="_blank" outside a session.
    const { AIAnswer } = await import('@renderer/components/affect/ai-answer')
    const { ThinkingState } = await import('@renderer/components/affect/thinking-state')

    const answerInSession = renderToStaticMarkup(
      createElement(
        openLink.LinkSessionContext,
        { value: 'sess-ui' },
        createElement(AIAnswer, {
          sources: [{ title: 'Docs', name: 'Docs', href: PR_URL }],
          answer: 'See [1]',
          animate: false,
        }),
      ),
    )
    expect(answerInSession).toContain(`href="${PR_URL}"`)
    expect(answerInSession).not.toContain('target="_blank"')

    const answerOutside = renderToStaticMarkup(
      createElement(AIAnswer, {
        sources: [{ title: 'Docs', name: 'Docs', href: PR_URL }],
        answer: 'See [1]',
        animate: false,
      }),
    )
    expect(answerOutside).toContain('target="_blank"')

    const thinkingInSession = renderToStaticMarkup(
      createElement(
        openLink.LinkSessionContext,
        { value: 'sess-ui' },
        createElement(ThinkingState, {
          steps: [
            {
              kind: 'search',
              label: 'Checking PR',
              sources: [{ label: 'PR #42', href: PR_URL }],
            },
          ],
          stepMs: 0,
        }),
      ),
    )
    expect(thinkingInSession).toContain(`href="${PR_URL}"`)
    expect(thinkingInSession).not.toContain('target="_blank"')

    const thinkingOutside = renderToStaticMarkup(
      createElement(ThinkingState, {
        steps: [
          {
            kind: 'search',
            label: 'Checking PR',
            sources: [{ label: 'PR #42', href: PR_URL }],
          },
        ],
        stepMs: 0,
      }),
    )
    expect(thinkingOutside).toContain('target="_blank"')
  }, 15_000)

  it('mounts LinkConfirmHost globally and preserves explicit external link entry points', () => {
    const appSource = readSource('src/app/app.tsx')
    expect(appSource).toContain('<LinkConfirmHost />')

    // Session-associated call sites route through the shared helper instead of raw target="_blank" / window.open.
    for (const rel of [
      'src/features/sidebar/card-outputs.tsx',
      'src/features/sidebar/pr-badge.tsx',
      'src/features/sidebar/session-menu.tsx',
      'src/features/overview/parts.tsx',
      'src/features/git/pr-bar-chip.tsx',
      'src/features/git/branch-tree.tsx',
      'src/features/git/next-step-card.tsx',
      'src/features/git/pane/pane-top.tsx',
      'src/features/git/steps.ts',
      'src/features/terminal/xterm-registry.ts',
    ]) {
      const code = readSource(rel)
      expect(code, rel).not.toContain('target="_blank"')
      expect(code, rel).not.toContain('window.open(')
    }

    // Explicit external entry points stay external.
    expect(readSource('src/features/browser/browser-pane.tsx')).toContain(
      'window.kettu.browser.openExternal',
    )
    expect(readSource('src/features/files/html-preview.ts')).toContain(
      "window.open(url, '_blank', 'noreferrer')",
    )
    expect(readSource('src/features/session/entries/elicitation-card.tsx')).toContain(
      "openLinkIn(request.url, 'browser', null)",
    )
    expect(readSource('src/features/settings/sections.tsx')).toContain('target="_blank"')
    expect(readSource('src/features/updates/update-dialog.tsx')).toContain('target="_blank"')
    expect(readSource('src/features/account/account-menu.tsx')).toContain(
      "window.open(url, '_blank', 'noreferrer')",
    )
  })
})
