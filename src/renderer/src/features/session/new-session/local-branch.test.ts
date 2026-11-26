import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { BranchList, GitStatus } from '@shared/git'

const hostMock = vi.fn()
const hostAtMock = vi.fn()

vi.mock('@renderer/lib/host', () => ({
  host: (...args: unknown[]) => hostMock(...args),
  hostAt: (...args: unknown[]) => hostAtMock(...args),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  errorCode: (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null,
}))

vi.mock('@renderer/lib/i18n', () => ({
  i18n: {
    t: (key: string, values?: Record<string, string | number>) => {
      if (key === 'git:failure.operation.switch') return 'Switch'
      if (key === 'git:failure.localChanges') {
        return `${values?.operation ?? 'Switch'} stopped: local changes would be overwritten.`
      }
      if (key === 'git:failure.busy') return 'Another git operation is running in this repository.'
      if (key === 'git:failure.other') {
        return `${values?.operation ?? 'Switch'} failed: ${values?.detail ?? ''}`
      }
      return key
    },
  },
}))

vi.mock('@renderer/stores/agents', () => ({
  agentsOn: () => ({ byId: {} }),
  useAgentsStore: { getState: () => ({ byId: {}, hosts: {} }) },
}))

import { useAgentOptionsStore } from '@renderer/stores/agent-options'
import { receiveGitStatus, useGitStore } from '@renderer/stores/git'
import {
  chooseBase,
  chooseWhere,
  useWorktreeChoice,
  worktreeRequest,
} from '@renderer/stores/worktree-choice'
import {
  buildLocalBranchModel,
  LOCAL_NEW_BRANCH,
  runningLocalSessionsCount,
  switchLocalBranch,
} from './local-branch'
import { prepareFor } from './prepared'

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    projectPath: '/tmp/repo',
    repo: { root: '/tmp/repo', gitDir: '/tmp/repo/.git' },
    head: { branch: 'main', oid: '1111111111111111111111111111111111111111', detached: false },
    upstream: null,
    base: null,
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0 },
    operation: null,
    commits: [],
    remote: null,
    defaultBranch: 'main',
    push: null,
    lastFetchedAt: null,
    updatedAt: 1,
    stale: false,
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    agentId: 'fake-agent',
    projectPath: '/tmp/repo',
    scratch: false,
    title: null,
    status: 'running',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    origin: 'user',
    routine: null,
    description: null,
    missing: false,
    branch: 'main',
    pr: null,
    cache: null,
    model: null,
    pinnedAt: null,
    archivedAt: null,
    acpSessionId: null,
    ...overrides,
  } as SessionSummary
}

const sampleBranches: BranchList = {
  branches: [
    {
      name: 'fix/sidebar-scroll',
      oid: '2222222',
      committedAt: 3000,
      current: false,
      worktree: null,
    },
    {
      name: 'feat/auth-refresh',
      oid: '3333333',
      committedAt: 2000,
      current: false,
      worktree: '/tmp/repo-wt-auth',
    },
    {
      name: 'main',
      oid: '1111111',
      committedAt: 1000,
      current: true,
      worktree: null,
    },
  ],
  remoteBranches: [{ name: 'origin/main', oid: '1111111', committedAt: 1000 }],
  remotes: [],
}

describe('local branch picker model and switching', () => {
  beforeEach(() => {
    hostMock.mockReset()
    hostAtMock.mockReset()
    useGitStore.setState({
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
    })
    useWorktreeChoice.setState({
      where: {},
      base: {},
      slug: null,
      template: {},
      templateError: {},
    })
    useAgentOptionsStore.setState({
      byId: {},
      loaded: true,
      hosts: {},
      error: null,
      picks: {},
      prepared: null,
      firstReads: {},
    })
  })

  it('orders current branch first, preserves worktree occupancy metadata, and omits remote branches', () => {
    const model = buildLocalBranchModel(sampleBranches, makeStatus(), '')
    expect(model.current).toBe('main')
    expect(model.groups).toEqual([
      { value: 'local', items: ['main', 'fix/sidebar-scroll', 'feat/auth-refresh'] },
    ])
    expect(model.byName.get('feat/auth-refresh')?.worktree).toBe('/tmp/repo-wt-auth')
    expect(model.byName.get('fix/sidebar-scroll')?.worktree).toBeNull()
    expect(model.createName).toBeNull()
  })

  it('offers creating a new branch when the query is valid and not yet a local branch', () => {
    const model = buildLocalBranchModel(sampleBranches, makeStatus(), '  feat/new-ui  ')
    expect(model.createName).toBe('feat/new-ui')
    expect(model.groups).toEqual([
      { value: 'local', items: ['main', 'fix/sidebar-scroll', 'feat/auth-refresh'] },
      { value: 'new', items: [LOCAL_NEW_BRANCH] },
    ])

    // Existing branch name or invalid ref name does not offer creation.
    expect(buildLocalBranchModel(sampleBranches, makeStatus(), 'main').createName).toBeNull()
    expect(buildLocalBranchModel(sampleBranches, makeStatus(), '-bad-flag').createName).toBeNull()
    expect(buildLocalBranchModel(sampleBranches, makeStatus(), 'bad name').createName).toBeNull()
  })

  it('handles detached HEAD by listing local branches with default first', () => {
    const detached = makeStatus({
      head: { branch: null, oid: 'deadbeef', detached: true },
      defaultBranch: 'main',
    })
    const model = buildLocalBranchModel(sampleBranches, detached, '')
    expect(model.current).toBeNull()
    expect(model.groups).toEqual([
      { value: 'local', items: ['main', 'fix/sidebar-scroll', 'feat/auth-refresh'] },
    ])
  })

  it('counts only active non-worktree sessions in the same project and deduplicates subagents', () => {
    const projectPath = '/tmp/repo'
    const byId: Record<string, SessionSummary> = {
      runningLocal: makeSession({ id: 'runningLocal', status: 'running' }),
      subagentOfRunning: makeSession({
        id: 'subagentOfRunning',
        parentId: 'runningLocal',
        origin: 'subagent',
        status: 'running',
      }),
      awaitingPermission: makeSession({ id: 'awaitingPermission', status: 'awaiting_permission' }),
      idleLocal: makeSession({ id: 'idleLocal', status: 'ready' }),
      archivedRunning: makeSession({ id: 'archivedRunning', status: 'running', archivedAt: 10 }),
      inWorktree: makeSession({
        id: 'inWorktree',
        status: 'running',
        worktree: {
          path: '/tmp/repo-wt',
          branch: 'feat/x',
          base: 'main',
          baseOid: '1111111',
          state: 'ready',
        },
      }),
      prepared: makeSession({
        id: 'prepared',
        status: 'running',
        prepared: { config: [], commands: [], notices: [], openedAt: 1 },
      }),
      otherProject: makeSession({
        id: 'otherProject',
        projectPath: '/tmp/other',
        status: 'running',
      }),
    }
    expect(runningLocalSessionsCount(byId, projectPath)).toBe(2)
  })

  it('switches branch via git.switchBranch, updates git status, refreshes project git data, and replaces prepared session', async () => {
    const projectPath = 'host-a:/workspace/app'
    const before = makeStatus({ projectPath })
    const after = makeStatus({
      projectPath,
      head: {
        branch: 'fix/sidebar-scroll',
        oid: '2222222222222222222222222222222222222222',
        detached: false,
      },
    })
    receiveGitStatus(before)

    hostMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'sessions.prepare') {
        return makeSession({
          id: params.replace ? 'prep-2' : 'prep-1',
          projectPath,
          status: 'ready',
          prepared: { config: [], commands: [], notices: [], openedAt: params.replace ? 2 : 1 },
        })
      }
      if (method === 'git.switchBranch') return { status: after, log: '' }
      if (method === 'git.status') return after
      if (method === 'git.currentPullRequest') return null
      return null
    })
    hostAtMock.mockResolvedValue({
      git: { found: true, version: '2.45' },
      gh: { state: 'ready', version: '2.60', account: 'dev' },
    })

    // Seed a prepared session targeting the same remote projectPath.
    prepareFor({ hostId: 'host-a', agentId: 'fake-agent', projectPath, parentId: null })
    await Promise.resolve()
    await Promise.resolve()

    const outcome = await switchLocalBranch(projectPath, 'fix/sidebar-scroll', false)
    expect(outcome).toEqual({
      ok: true,
      status: after,
      branch: 'fix/sidebar-scroll',
      created: false,
    })
    expect(hostMock).toHaveBeenCalledWith('git.switchBranch', {
      projectPath,
      branch: 'fix/sidebar-scroll',
      create: false,
    })
    expect(useGitStore.getState().status[projectPath]?.head.branch).toBe('fix/sidebar-scroll')
    expect(hostMock).toHaveBeenCalledWith('git.status', { projectPath })
    expect(hostMock).toHaveBeenCalledWith('git.currentPullRequest', { projectPath })
    expect(hostMock).toHaveBeenCalledWith(
      'sessions.prepare',
      expect.objectContaining({ projectPath, agentId: 'fake-agent', replace: true }),
    )
  })

  it('surfaces dirty working tree switch failures clearly and suggests switching to a new worktree', async () => {
    const projectPath = '/tmp/repo'
    const dirty = makeStatus({
      projectPath,
      changes: { staged: 0, unstaged: 2, untracked: 0, conflicted: 0, insertions: 5, deletions: 1 },
    })
    receiveGitStatus(dirty)

    hostMock.mockRejectedValueOnce(
      new Error(
        'error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/app.ts\nPlease commit your changes or stash them before you switch branches.',
      ),
    )

    const outcome = await switchLocalBranch(projectPath, 'fix/sidebar-scroll', false)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.kind).toBe('localChanges')
      expect(outcome.busy).toBe(false)
      expect(outcome.suggestWorktree).toBe(true)
      expect(outcome.message).toBe('Switch stopped: local changes would be overwritten.')
      expect(outcome.log).toContain('would be overwritten by checkout')
    }
    // Current branch stays untouched after a failed switch.
    expect(useGitStore.getState().status[projectPath]?.head.branch).toBe('main')
  })

  it('recognizes untracked file checkout conflicts as localChanges and suggests new worktree', async () => {
    const projectPath = '/tmp/repo'
    receiveGitStatus(
      makeStatus({
        projectPath,
        changes: {
          staged: 0,
          unstaged: 0,
          untracked: 1,
          conflicted: 0,
          insertions: 0,
          deletions: 0,
        },
      }),
    )

    hostMock.mockRejectedValueOnce(
      new Error(
        'error: The following untracked working tree files would be overwritten by checkout:\n\tscroll.txt\nPlease move or remove them before you switch branches.',
      ),
    )

    const outcome = await switchLocalBranch(projectPath, 'fix/sidebar-scroll', false)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.kind).toBe('localChanges')
      expect(outcome.suggestWorktree).toBe(true)
      expect(outcome.message).toBe('Switch stopped: local changes would be overwritten.')
    }
  })

  it('creates and switches to a new local branch when create is true', async () => {
    const projectPath = '/tmp/repo'
    const after = makeStatus({
      projectPath,
      head: { branch: 'feat/brand-new', oid: '1111111', detached: false },
    })
    receiveGitStatus(makeStatus({ projectPath }))
    hostMock.mockImplementation(async (method: string) => {
      if (method === 'git.switchBranch') return { status: after, log: '' }
      if (method === 'git.status') return after
      return null
    })
    hostAtMock.mockResolvedValue({
      git: { found: true, version: '2.45' },
      gh: { state: 'ready', version: '2.60', account: 'dev' },
    })

    const outcome = await switchLocalBranch(projectPath, 'feat/brand-new', true)
    expect(outcome).toEqual({
      ok: true,
      status: after,
      branch: 'feat/brand-new',
      created: true,
    })
    expect(hostMock).toHaveBeenCalledWith('git.switchBranch', {
      projectPath,
      branch: 'feat/brand-new',
      create: true,
    })
  })

  it('reports busy git operations without suggesting worktree replacement', async () => {
    const projectPath = '/tmp/repo'
    receiveGitStatus(makeStatus({ projectPath }))
    useGitStore.setState((s) => ({
      running: { ...s.running, [projectPath]: { kind: 'fetch', startedAt: 1 } },
    }))

    const outcome = await switchLocalBranch(projectPath, 'fix/sidebar-scroll', false)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.kind).toBe('busy')
      expect(outcome.busy).toBe(true)
      expect(outcome.suggestWorktree).toBe(false)
      expect(outcome.message).toBe('Another git operation is running in this repository.')
    }
    expect(hostMock).not.toHaveBeenCalled()
  })

  it('keeps worktree mode selection independent from local branch switching', () => {
    const projectPath = '/tmp/repo'
    chooseWhere(projectPath, 'worktree')
    chooseBase(projectPath, 'fix/sidebar-scroll')
    expect(worktreeRequest(projectPath, 'main')).toEqual({ base: 'fix/sidebar-scroll' })

    chooseWhere(projectPath, 'local')
    expect(worktreeRequest(projectPath, 'main')).toBeNull()
  })
})
