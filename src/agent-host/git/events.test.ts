import type { GitStatus } from '@shared/git'
import type { ToolKind } from '@shared/thread'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  canChangeRepository,
  computeGitEvents,
  extractPullRequestUrl,
  listNewCommits,
} from './events'
import { emptyStatus } from './status'
import { createSandbox, type Sandbox } from './test-support'

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    ...emptyStatus('/work/app', 0),
    repo: { root: '/work/app', gitDir: '/work/app/.git' },
    head: { branch: 'feat/x', oid: 'a'.repeat(40), detached: false },
    ...overrides,
  }
}

const commit = (n: number) => ({ oid: String(n).repeat(40), subject: `commit ${n}` })
const listed = (n: number, pushed: boolean) => ({
  oid: String(n).repeat(40),
  subject: `commit ${n}`,
  authoredAt: 0,
  pushed,
})

describe('canChangeRepository', () => {
  it.each<[ToolKind, boolean]>([
    ['edit', true],
    ['delete', true],
    ['move', true],
    ['execute', true],
    ['other', true],
    ['read', false],
    ['search', false],
    ['think', false],
    ['fetch', false],
    ['switch_mode', false],
  ])('%s -> %s', (kind, expected) => {
    expect(canChangeRepository(kind)).toBe(expected)
  })
})

describe('extractPullRequestUrl', () => {
  it('finds the URL that gh pr create prints', () => {
    const output =
      'Creating pull request for feat/x into main in acme/app\n\nhttps://github.com/acme/app/pull/57\n'
    expect(extractPullRequestUrl(output)).toBe('https://github.com/acme/app/pull/57')
  })

  it('finds a URL anywhere in the text and keeps the last one', () => {
    const output =
      'see https://github.com/acme/app/pull/3 and then https://github.com/acme/app/pull/9/files.'
    expect(extractPullRequestUrl(output)).toBe('https://github.com/acme/app/pull/9')
  })

  it('ignores other URLs', () => {
    expect(extractPullRequestUrl('https://github.com/acme/app/issues/3')).toBeNull()
    expect(extractPullRequestUrl('https://github.com/acme/app/pulls')).toBeNull()
    expect(extractPullRequestUrl('https://gitlab.com/acme/app/pull/3')).toBeNull()
    expect(extractPullRequestUrl('xhttps://github.com/acme/app/pull/3')).toBeNull()
    expect(extractPullRequestUrl('')).toBeNull()
  })
})

describe('computeGitEvents', () => {
  const none = { newCommits: [], output: '' }

  it('has nothing to say when nothing changed', () => {
    expect(computeGitEvents({ before: status(), after: status(), ...none })).toEqual([])
  })

  it('reports a switch to another branch', () => {
    const after = status({ head: { branch: 'fix/flaky', oid: 'b'.repeat(40), detached: false } })
    expect(computeGitEvents({ before: status(), after, ...none })).toEqual([
      { kind: 'git', event: 'branch', branch: 'fix/flaky' },
    ])
  })

  it('does not report a switch from or to a detached head or an unborn branch', () => {
    const detached = status({ head: { branch: null, oid: 'c'.repeat(40), detached: true } })
    expect(computeGitEvents({ before: detached, after: status(), ...none })).toEqual([])
    expect(computeGitEvents({ before: status(), after: detached, ...none })).toEqual([])
  })

  it('lists at most three commits and counts the rest', () => {
    const newCommits = [1, 2, 3, 4, 5].map(commit)
    const events = computeGitEvents({ before: status(), after: status(), newCommits, output: '' })
    expect(events).toEqual([
      { kind: 'git', event: 'commit', commits: newCommits.slice(0, 3), more: 2 },
    ])
  })

  it('lists one commit without a remainder', () => {
    const events = computeGitEvents({
      before: status(),
      after: status(),
      newCommits: [commit(1)],
      output: '',
    })
    expect(events).toEqual([{ kind: 'git', event: 'commit', commits: [commit(1)], more: 0 }])
  })

  it('reports a push when ahead falls', () => {
    const before = status({ upstream: { name: 'origin/feat/x', ahead: 3, behind: 0 } })
    const after = status({ upstream: { name: 'origin/feat/x', ahead: 1, behind: 0 } })
    expect(computeGitEvents({ before, after, ...none })).toEqual([
      { kind: 'git', event: 'push', upstream: 'origin/feat/x', count: 2 },
    ])
  })

  it('reports a commit that was made and pushed in the same call', () => {
    const upstream = { name: 'origin/feat/x', ahead: 0, behind: 0 }
    const events = computeGitEvents({
      before: status({ upstream }),
      after: status({ upstream, head: { branch: 'feat/x', oid: 'd'.repeat(40), detached: false } }),
      newCommits: [commit(1)],
      output: '',
    })
    expect(events.map((e) => e.event)).toEqual(['commit', 'push'])
    expect(events[1]).toMatchObject({ count: 1 })
  })

  it('does not report a push for a new local commit, a pull, or a growing ahead count', () => {
    const before = status({ upstream: { name: 'origin/feat/x', ahead: 0, behind: 2 } })
    const pulled = status({ upstream: { name: 'origin/feat/x', ahead: 0, behind: 0 } })
    expect(computeGitEvents({ before, after: pulled, ...none })).toEqual([])
    const ahead = status({ upstream: { name: 'origin/feat/x', ahead: 1, behind: 0 } })
    const events = computeGitEvents({
      before: status({ upstream: { name: 'origin/feat/x', ahead: 0, behind: 0 } }),
      after: ahead,
      newCommits: [commit(1)],
      output: '',
    })
    expect(events.map((e) => e.event)).toEqual(['commit'])
  })

  it('reports a branch gaining an upstream', () => {
    const after = status({
      upstream: { name: 'origin/feat/x', ahead: 0, behind: 0 },
      commits: [listed(2, true), listed(1, true)],
    })
    expect(computeGitEvents({ before: status(), after, ...none })).toEqual([
      { kind: 'git', event: 'push', upstream: 'origin/feat/x', count: 2 },
    ])
  })

  it('still reports a publish when no commit is listed', () => {
    const after = status({ upstream: { name: 'origin/feat/x', ahead: 0, behind: 0 } })
    expect(computeGitEvents({ before: status(), after, ...none })).toEqual([
      { kind: 'git', event: 'push', upstream: 'origin/feat/x', count: 0 },
    ])
  })

  it('does not call a switch to a branch that already has an upstream a push', () => {
    const before = status({ upstream: { name: 'origin/feat/x', ahead: 2, behind: 0 } })
    const after = status({
      head: { branch: 'other', oid: 'b'.repeat(40), detached: false },
      upstream: { name: 'origin/other', ahead: 0, behind: 0 },
      commits: [listed(5, true)],
    })
    expect(computeGitEvents({ before, after, ...none }).map((e) => e.event)).toEqual(['branch'])
  })

  it('reports a new branch, its commit and its push from one call', () => {
    const before = status({ head: { branch: 'main', oid: 'a'.repeat(40), detached: false } })
    const after = status({
      head: { branch: 'feat/new', oid: 'b'.repeat(40), detached: false },
      upstream: { name: 'origin/feat/new', ahead: 0, behind: 0 },
      commits: [listed(1, true)],
    })
    const events = computeGitEvents({ before, after, newCommits: [commit(1)], output: '' })
    expect(events.map((e) => e.event)).toEqual(['branch', 'commit', 'push'])
    expect(events[2]).toMatchObject({ upstream: 'origin/feat/new', count: 1 })
  })

  it('reports a pull request URL in the output', () => {
    const events = computeGitEvents({
      before: status(),
      after: status(),
      newCommits: [],
      output: 'https://github.com/acme/app/pull/57',
    })
    expect(events).toEqual([
      { kind: 'git', event: 'pull_request', url: 'https://github.com/acme/app/pull/57' },
    ])
  })

  it('says nothing for a stale or non-repository status', () => {
    const output = 'https://github.com/acme/app/pull/57'
    const newCommits = [commit(1)]
    expect(
      computeGitEvents({ before: status(), after: status({ stale: true }), newCommits, output }),
    ).toEqual([])
    expect(
      computeGitEvents({ before: status({ repo: null }), after: status(), newCommits, output }),
    ).toEqual([])
    expect(
      computeGitEvents({ before: status(), after: status({ repo: null }), newCommits, output }),
    ).toEqual([])
  })
})

describe('listNewCommits', () => {
  let s: Sandbox
  beforeAll(async () => {
    s = await createSandbox()
  })
  afterAll(async () => {
    await s.dispose()
  })

  const nowSeconds = (): number => Math.floor(Date.now() / 1000)

  it('lists the commits between two ids, newest first', async () => {
    const dir = await s.initRepo('range')
    const first = await s.commit(dir, 'a.txt', 'chore: first')
    const second = await s.commit(dir, 'b.txt', 'feat: second')
    const third = await s.commit(dir, 'c.txt', 'feat: third')
    const list = await listNewCommits(s.exec, dir, first, third, nowSeconds() - 60)
    expect(list).toEqual([
      { oid: third, subject: 'feat: third' },
      { oid: second, subject: 'feat: second' },
    ])
  })

  it('lists the whole history after a first commit', async () => {
    const dir = await s.initRepo('first')
    const first = await s.commit(dir, 'a.txt', 'chore: first')
    expect(await listNewCommits(s.exec, dir, null, first, nowSeconds() - 60)).toEqual([
      { oid: first, subject: 'chore: first' },
    ])
  })

  it('leaves out commits older than the tool call, as a pull brings them', async () => {
    const dir = await s.initRepo('old')
    const first = await s.commit(dir, 'a.txt', 'chore: first')
    const second = await s.commit(dir, 'b.txt', 'feat: second')
    expect(await listNewCommits(s.exec, dir, first, second, nowSeconds() + 3600)).toEqual([])
  })

  it('has no commits when the target is an ancestor of the start', async () => {
    const dir = await s.initRepo('reset')
    const first = await s.commit(dir, 'a.txt', 'chore: first')
    const second = await s.commit(dir, 'b.txt', 'feat: second')
    expect(await listNewCommits(s.exec, dir, second, first, 0)).toEqual([])
  })
})
