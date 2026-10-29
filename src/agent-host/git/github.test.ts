import { describe, expect, it } from 'vitest'
import {
  mapAvatarUrl,
  mapBranchPullRequests,
  mapPullRequest,
  nextPollDelayMs,
  summarizeChecks,
  userArgs,
  viewArgs,
} from './github'

const checkRun = (status: string, conclusion: string | null) => ({
  __typename: 'CheckRun',
  name: 'build',
  status,
  conclusion,
})
const statusContext = (state: string) => ({ __typename: 'StatusContext', context: 'ci', state })

describe('summarizeChecks', () => {
  it('has no state without checks', () => {
    const none = { state: 'none', passed: 0, failed: 0, pending: 0, runs: [] }
    expect(summarizeChecks([])).toEqual(none)
    expect(summarizeChecks(null)).toEqual(none)
    expect(summarizeChecks(undefined).state).toBe('none')
  })

  it('passes when every check succeeded, was skipped or neutral', () => {
    const checks = summarizeChecks([
      checkRun('COMPLETED', 'SUCCESS'),
      checkRun('COMPLETED', 'SKIPPED'),
      checkRun('COMPLETED', 'NEUTRAL'),
      statusContext('SUCCESS'),
    ])
    expect(checks).toMatchObject({ state: 'passing', passed: 4, failed: 0, pending: 0 })
  })

  it('is pending while a run has not completed', () => {
    for (const status of ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED']) {
      expect(
        summarizeChecks([checkRun('COMPLETED', 'SUCCESS'), checkRun(status, null)]),
      ).toMatchObject({
        state: 'pending',
        passed: 1,
        failed: 0,
        pending: 1,
      })
    }
  })

  it('is pending for a pending or expected status context', () => {
    expect(summarizeChecks([statusContext('PENDING')]).state).toBe('pending')
    expect(summarizeChecks([statusContext('EXPECTED')]).state).toBe('pending')
  })

  it('fails when anything failed, even with pending runs', () => {
    const checks = summarizeChecks([
      checkRun('COMPLETED', 'SUCCESS'),
      checkRun('IN_PROGRESS', null),
      checkRun('COMPLETED', 'FAILURE'),
    ])
    expect(checks).toMatchObject({ state: 'failing', passed: 1, failed: 1, pending: 1 })
  })

  it('lists each run, failing first, then pending, then passed, by name', () => {
    const { runs } = summarizeChecks([
      { ...checkRun('COMPLETED', 'SUCCESS'), name: 'lint', workflowName: 'CI' },
      {
        ...checkRun('IN_PROGRESS', null),
        name: 'e2e',
        startedAt: '2026-10-20T08:00:00Z',
        completedAt: '0001-01-01T00:00:00Z',
        detailsUrl: 'https://github.com/acme/app/actions/runs/1',
      },
      { ...checkRun('COMPLETED', 'FAILURE'), name: 'build', workflowName: 'build' },
      { ...statusContext('SUCCESS'), targetUrl: 'http://ci.example.com/1' },
    ])
    expect(runs).toEqual([
      { name: 'build', outcome: 'failed', url: null, startedAt: null, completedAt: null },
      {
        name: 'e2e',
        outcome: 'pending',
        url: 'https://github.com/acme/app/actions/runs/1',
        startedAt: Date.parse('2026-10-20T08:00:00Z'),
        completedAt: null,
      },
      { name: 'ci', outcome: 'passed', url: null, startedAt: null, completedAt: null },
      { name: 'CI / lint', outcome: 'passed', url: null, startedAt: null, completedAt: null },
    ])
  })

  it.each(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'STALE'])(
    'counts a %s run as failed',
    (conclusion) => {
      expect(summarizeChecks([checkRun('COMPLETED', conclusion)]).state).toBe('failing')
    },
  )

  it.each(['FAILURE', 'ERROR'])('counts a %s status context as failed', (state) => {
    expect(summarizeChecks([statusContext(state)]).state).toBe('failing')
  })

  it('reads the shape when the type name is missing', () => {
    expect(
      summarizeChecks([{ state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]),
    ).toMatchObject({
      state: 'failing',
      passed: 1,
      failed: 1,
      pending: 0,
    })
  })

  it('treats a completed run without a conclusion as pending and ignores junk', () => {
    expect(summarizeChecks([checkRun('COMPLETED', null), 'junk', null]).state).toBe('pending')
  })
})

const view = {
  number: 42,
  title: 'fix(auth): read the clock once',
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/acme/app/pull/42',
  headRefName: 'fix/flaky-login',
  baseRefName: 'main',
  reviewDecision: 'APPROVED',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [checkRun('COMPLETED', 'SUCCESS')],
  updatedAt: '2026-10-20T08:30:00Z',
  author: { id: 'U_kgDOAAAAAA', is_bot: false, login: 'mirachen', name: 'Mira Chen' },
  createdAt: '2026-10-19T16:05:00Z',
  mergedAt: null,
  closedAt: null,
}

describe('mapPullRequest', () => {
  it('maps an open pull request', () => {
    expect(mapPullRequest(view)).toEqual({
      url: 'https://github.com/acme/app/pull/42',
      owner: 'acme',
      repo: 'app',
      number: 42,
      title: 'fix(auth): read the clock once',
      state: 'open',
      head: 'fix/flaky-login',
      base: 'main',
      checks: {
        state: 'passing',
        passed: 1,
        failed: 0,
        pending: 0,
        runs: [{ name: 'build', outcome: 'passed', url: null, startedAt: null, completedAt: null }],
      },
      review: 'approved',
      mergeable: 'clean',
      updatedAt: Date.parse('2026-10-20T08:30:00Z'),
      author: { login: 'mirachen', name: 'Mira Chen', bot: false },
      createdAt: Date.parse('2026-10-19T16:05:00Z'),
      mergedAt: null,
      closedAt: null,
    })
  })

  it('maps an author without a profile name', () => {
    const author = { id: 'U_kgDOAAAAAB', is_bot: false, login: 'jweber', name: '' }
    expect(mapPullRequest({ ...view, author }).author).toEqual({
      login: 'jweber',
      name: null,
      bot: false,
    })
  })

  it("maps a GitHub App's bot to its user name on GitHub", () => {
    const author = { is_bot: true, login: 'app/kettu-builder' }
    expect(mapPullRequest({ ...view, author }).author).toEqual({
      login: 'kettu-builder[bot]',
      name: null,
      bot: true,
    })
  })

  it.each([null, undefined, {}, { login: '' }, 'ghost'])(
    'has no author for %j, as for a deleted account',
    (author) => {
      expect(mapPullRequest({ ...view, author }).author).toBeNull()
    },
  )

  it('maps when it was merged or closed', () => {
    const merged = mapPullRequest({
      ...view,
      state: 'MERGED',
      mergedAt: '2026-10-21T09:00:00Z',
      closedAt: '2026-10-21T09:00:00Z',
    })
    expect(merged.mergedAt).toBe(Date.parse('2026-10-21T09:00:00Z'))
    expect(merged.closedAt).toBe(Date.parse('2026-10-21T09:00:00Z'))
    const closed = mapPullRequest({ ...view, state: 'CLOSED', closedAt: '2026-10-22T10:00:00Z' })
    expect(closed.mergedAt).toBeNull()
    expect(closed.closedAt).toBe(Date.parse('2026-10-22T10:00:00Z'))
    expect(mapPullRequest({ ...view, mergedAt: '0001-01-01T00:00:00Z' }).mergedAt).toBeNull()
  })

  it.each([
    [{ state: 'OPEN', isDraft: true }, 'draft'],
    [{ state: 'OPEN', isDraft: false }, 'open'],
    [{ state: 'MERGED', isDraft: false }, 'merged'],
    [{ state: 'CLOSED', isDraft: true }, 'closed'],
  ])('maps %j to the state %s', (fields, state) => {
    expect(mapPullRequest({ ...view, ...fields }).state).toBe(state)
  })

  it.each([
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'changes_requested'],
    ['REVIEW_REQUIRED', 'review_required'],
    ['', null],
    [null, null],
  ])('maps the review decision %j to %j', (decision, review) => {
    expect(mapPullRequest({ ...view, reviewDecision: decision }).review).toBe(review)
  })

  it.each([
    ['CLEAN', 'clean'],
    ['HAS_HOOKS', 'clean'],
    ['UNSTABLE', 'clean'],
    ['DIRTY', 'conflicting'],
    ['BLOCKED', 'blocked'],
    ['BEHIND', 'blocked'],
    ['DRAFT', 'blocked'],
    ['UNKNOWN', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ])('maps the merge state %j to %j', (mergeStateStatus, mergeable) => {
    expect(mapPullRequest({ ...view, mergeStateStatus }).mergeable).toBe(mergeable)
  })

  it('tolerates missing optional fields', () => {
    const pr = mapPullRequest({ url: view.url, state: 'MERGED' })
    expect(pr).toMatchObject({
      number: 42,
      title: '',
      head: '',
      checks: { state: 'none' },
      review: null,
      mergeable: 'unknown',
      updatedAt: 0,
      author: null,
      createdAt: 0,
      mergedAt: null,
      closedAt: null,
    })
  })

  it('rejects output that is not a github.com pull request', () => {
    expect(() => mapPullRequest(null)).toThrow()
    expect(() => mapPullRequest([])).toThrow()
    expect(() =>
      mapPullRequest({ ...view, url: 'https://github.example.com/a/b/pull/1' }),
    ).toThrow()
    expect(() => mapPullRequest({ ...view, url: undefined })).toThrow()
  })
})

describe('mapBranchPullRequests', () => {
  it('maps head branches to their pull requests', () => {
    const map = mapBranchPullRequests([
      {
        number: 3,
        state: 'OPEN',
        isDraft: true,
        url: 'https://github.com/a/b/pull/3',
        headRefName: 'x',
      },
      {
        number: 2,
        state: 'MERGED',
        isDraft: false,
        url: 'https://github.com/a/b/pull/2',
        headRefName: 'y',
      },
    ])
    expect(map.get('x')).toEqual({
      number: 3,
      state: 'draft',
      url: 'https://github.com/a/b/pull/3',
    })
    expect(map.get('y')).toEqual({
      number: 2,
      state: 'merged',
      url: 'https://github.com/a/b/pull/2',
    })
    expect(map.size).toBe(2)
  })

  it('prefers an open pull request, then the newest, for a shared branch', () => {
    const pr = (number: number, state: string) => ({
      number,
      state,
      isDraft: false,
      url: `https://github.com/a/b/pull/${number}`,
      headRefName: 'x',
    })
    expect(
      mapBranchPullRequests([pr(9, 'CLOSED'), pr(7, 'OPEN'), pr(5, 'MERGED')]).get('x')?.number,
    ).toBe(7)
    expect(mapBranchPullRequests([pr(9, 'CLOSED'), pr(7, 'MERGED')]).get('x')?.number).toBe(9)
  })

  it('skips malformed items and rejects a non-list', () => {
    expect(mapBranchPullRequests([{ number: 1 }, 'x', null]).size).toBe(0)
    expect(() => mapBranchPullRequests({})).toThrow()
  })
})

describe('gh arguments and schedule', () => {
  it('asks for the documented fields', () => {
    expect(viewArgs()).toEqual([
      'pr',
      'view',
      '--json',
      'number,title,state,isDraft,url,headRefName,baseRefName,reviewDecision,mergeStateStatus,statusCheckRollup,updatedAt,author,createdAt,mergedAt,closedAt',
    ])
    expect(viewArgs('https://github.com/a/b/pull/1').slice(0, 3)).toEqual([
      'pr',
      'view',
      'https://github.com/a/b/pull/1',
    ])
  })

  it('looks a user up on github.com', () => {
    expect(userArgs('kettu-builder[bot]')).toEqual([
      'api',
      '--hostname',
      'github.com',
      'users/kettu-builder[bot]',
    ])
  })

  it('polls every minute while checks are pending and every five otherwise', () => {
    const base = mapPullRequest(view)
    expect(nextPollDelayMs(null)).toBe(300_000)
    expect(nextPollDelayMs(base)).toBe(300_000)
    expect(nextPollDelayMs({ ...base, checks: { ...base.checks, state: 'pending' } })).toBe(60_000)
  })
})

describe('mapAvatarUrl', () => {
  it("takes the avatar URL that GitHub's avatar host serves", () => {
    const url = 'https://avatars.githubusercontent.com/in/5463070?v=4'
    expect(mapAvatarUrl({ login: 'kettu-builder[bot]', avatar_url: url })).toBe(url)
  })

  it.each([
    'http://avatars.githubusercontent.com/u/1?v=4',
    'https://avatars.githubusercontent.com.example.com/u/1',
    'https://example.com/avatars.githubusercontent.com/u/1',
    '',
    42,
  ])('refuses %j', (avatar_url) => {
    expect(mapAvatarUrl({ avatar_url })).toBeNull()
  })

  it('refuses output that is not a user', () => {
    expect(mapAvatarUrl(null)).toBeNull()
    expect(mapAvatarUrl(['https://avatars.githubusercontent.com/u/1'])).toBeNull()
  })
})
