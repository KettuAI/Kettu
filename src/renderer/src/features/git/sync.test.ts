import { describe, expect, it } from 'vitest'
import type { GitStatus, PushTarget } from '@shared/git'
import {
  commandOf,
  failureOf,
  lastLine,
  planSync,
  projectRelative,
  pullRequestHead,
  pushesToDefault,
  suggestPullRequest,
} from './sync'

const github = { owner: 'a', repo: 'b' }
const to = (branch: string, more: Partial<PushTarget> = {}): PushTarget =>
  ({ kind: 'remote', remote: 'origin', github, branch, setUpstream: false, ...more }) as PushTarget

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    projectPath: '/p',
    repo: { root: '/p', gitDir: '/p/.git' },
    head: { branch: 'fix/flaky-login', oid: 'a'.repeat(40), detached: false },
    upstream: { name: 'origin/fix/flaky-login', ahead: 0, behind: 0 },
    base: { name: 'origin/main', ahead: 2, behind: 0 },
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0 },
    operation: null,
    commits: [],
    remote: { name: 'origin', url: 'git@github.com:a/b.git', github: { owner: 'a', repo: 'b' } },
    defaultBranch: 'main',
    push: to('fix/flaky-login'),
    lastFetchedAt: null,
    updatedAt: 1,
    stale: false,
    ...overrides,
  }
}

const upstream = (ahead: number, behind: number): Partial<GitStatus> => ({
  upstream: { name: 'origin/fix/flaky-login', ahead, behind },
})

describe('planSync', () => {
  it('pushes when ahead and pulls when behind', () => {
    expect(planSync(status(upstream(2, 0)), 'ready')).toMatchObject({
      pull: { kind: 'pull', enabled: false, reason: 'nothingToPull' },
      push: { kind: 'push', enabled: true, next: true, count: 2 },
      hint: null,
    })
    expect(planSync(status(upstream(0, 3)), 'ready')).toMatchObject({
      pull: { kind: 'pull', enabled: true, next: true, count: 3 },
      push: { kind: 'push', enabled: false, reason: 'nothingToPush' },
    })
  })

  it('refuses both and says why when the branch has diverged', () => {
    expect(planSync(status(upstream(2, 1)), 'ready')).toEqual({
      pull: { kind: 'pull', count: 1, enabled: false, next: false, reason: 'diverged' },
      push: { kind: 'push', count: 2, enabled: false, next: false, reason: 'diverged' },
      hint: 'diverged',
    })
  })

  it('is up to date in sync', () => {
    const plan = planSync(status(), 'ready')
    expect([plan.pull.enabled, plan.push.enabled, plan.hint]).toEqual([false, false, 'upToDate'])
  })

  it('publishes a branch without an upstream, and a repository without a remote', () => {
    const unpublished = { upstream: null, push: to('fix/flaky-login', { setUpstream: true }) }
    expect(planSync(status(unpublished), 'ready')).toMatchObject({
      pull: { enabled: false, reason: 'noUpstream' },
      push: { kind: 'publishBranch', enabled: true, next: true },
      hint: 'publishBranch',
    })
    const bare: Partial<GitStatus> = { upstream: null, remote: null, push: { kind: 'noRemote' } }
    expect(planSync(status(bare), 'ready')).toMatchObject({
      pull: { enabled: false, reason: 'noRemote' },
      push: { kind: 'publishRepo', enabled: true },
      hint: 'publishRepo',
    })
    expect(planSync(status(bare), 'signed-out')).toMatchObject({
      push: { kind: 'publishRepo', enabled: false, reason: 'ghSignedOut' },
      hint: 'ghSignedOut',
    })
    expect(planSync(status(bare), null).push.reason).toBe('ghMissing')
  })

  it('never offers to publish a repository that has a remote of another name', () => {
    expect(
      planSync(status({ remote: null, push: { kind: 'unknownRemote' } }), 'ready'),
    ).toMatchObject({
      push: { kind: 'push', enabled: false, reason: 'unknownRemote' },
      hint: 'unknownRemote',
    })
  })

  it('refuses to push where git would not, but still pulls', () => {
    const otherName = status({
      upstream: { name: 'origin/main', ahead: 1, behind: 2 },
      push: { kind: 'otherName', upstream: 'origin/main' },
    })
    expect(planSync(otherName, 'ready')).toMatchObject({
      pull: { enabled: false, reason: 'diverged' },
      push: { enabled: false, reason: 'otherName' },
      hint: 'otherName',
    })
    const local = status({
      upstream: { name: 'main', ahead: 0, behind: 1 },
      push: { kind: 'localUpstream' },
    })
    expect(planSync(local, 'ready')).toMatchObject({
      pull: { kind: 'pull', enabled: true, count: 1 },
      push: { enabled: false, reason: 'localUpstream' },
    })
  })

  it('pushes to a fork past an upstream it cannot count against', () => {
    const fork = status({ ...upstream(0, 4), push: to('fix/flaky-login', { remote: 'fork' }) })
    expect(planSync(fork, 'ready')).toMatchObject({
      pull: { enabled: true, count: 4, next: true },
      push: { kind: 'push', enabled: true, next: false, count: 0 },
      hint: null,
    })
  })

  it('offers nothing on a detached head, an unborn branch or during a rebase', () => {
    const detached = status({ head: { branch: null, oid: 'a'.repeat(40), detached: true } })
    expect(planSync(detached, 'ready').hint).toBe('noBranch')
    expect(
      planSync(status({ head: { branch: 'main', oid: null, detached: false } }), 'ready').hint,
    ).toBe('noBranch')
    const rebasing = status({ ...upstream(1, 0), operation: { kind: 'rebase', step: [2, 5] } })
    expect(planSync(rebasing, 'ready')).toMatchObject({
      push: { enabled: false, reason: 'operation' },
      hint: 'operation',
    })
  })
})

describe('pushesToDefault', () => {
  it('asks before a push or publish that lands on the default branch', () => {
    const onMain = status({
      head: { branch: 'main', oid: 'a'.repeat(40), detached: false },
      push: to('main'),
    })
    expect(pushesToDefault(onMain, 'push')).toBe(true)
    expect(pushesToDefault(onMain, 'publishBranch')).toBe(true)
    expect(pushesToDefault(onMain, 'pull')).toBe(false)
    expect(pushesToDefault(status(), 'push')).toBe(false)
    expect(pushesToDefault({ ...onMain, defaultBranch: null }, 'push')).toBe(false)
  })

  it('judges by where the push lands, not by the branch checked out', () => {
    // `fix` tracking origin/main with push.default=upstream pushes onto main.
    const fix = status({ head: { branch: 'fix', oid: 'a'.repeat(40), detached: false } })
    expect(pushesToDefault({ ...fix, push: to('main') }, 'push')).toBe(true)
    expect(pushesToDefault({ ...fix, push: to('fix') }, 'push')).toBe(false)
  })
})

describe('commandOf', () => {
  it('shows the refspec the host pushes', () => {
    const fix = status({ head: { branch: 'fix', oid: 'a'.repeat(40), detached: false } })
    expect(commandOf({ ...fix, push: to('main') }, 'push')).toBe('git push origin fix:main')
    expect(commandOf({ ...fix, push: to('fix', { setUpstream: true }) }, 'publishBranch')).toBe(
      'git push --set-upstream origin fix:fix',
    )
  })
})

describe('pullRequestHead', () => {
  it('names the pushed branch, from a fork as owner:branch', () => {
    expect(pullRequestHead(status())).toBe('fix/flaky-login')
    const fork = to('fix/flaky-login', { remote: 'fork', github: { owner: 'me', repo: 'b' } })
    expect(pullRequestHead(status({ push: fork }))).toBe('me:fix/flaky-login')
  })

  it('has none for an unpushed branch, the base itself or a remote off GitHub', () => {
    expect(pullRequestHead(status({ push: to('x', { setUpstream: true }) }))).toBeNull()
    expect(pullRequestHead(status({ push: to('main') }))).toBeNull()
    expect(pullRequestHead(status({ push: to('x', { github: null }) }))).toBeNull()
    expect(pullRequestHead(status({ push: { kind: 'otherName', upstream: 'origin/main' } }))).toBe(
      null,
    )
  })
})

describe('failureOf', () => {
  it.each([
    [' ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push', 'rejected'],
    ['fatal: Not possible to fast-forward, aborting.', 'notFastForward'],
    ['remote: Permission to a/b.git denied.\nfatal: unable to access: 403', 'auth'],
    [
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      'auth',
    ],
    ['fatal: unable to access: Could not resolve host: github.com', 'network'],
    [
      'error: Your local changes to the following files would be overwritten by merge:',
      'localChanges',
    ],
    ["fatal: '/x' does not appear to be a git repository", 'remoteMissing'],
    ['GraphQL: Name already exists on this account (createRepository)', 'nameTaken'],
    ['git push timed out after 60 s', 'timeout'],
    ['something else entirely', 'other'],
  ])('reads %j as %s', (log, kind) => {
    expect(failureOf(log)).toBe(kind)
  })

  it('picks the fatal line, else the last one', () => {
    expect(lastLine('To x\n ! [rejected] main\nerror: failed to push some refs\nhint: pull')).toBe(
      'error: failed to push some refs',
    )
    expect(lastLine('one\n\ntwo\n')).toBe('two')
    expect(lastLine('')).toBe('')
  })
})

describe('suggestPullRequest', () => {
  const commit = (subject: string) => ({ oid: subject, subject, authoredAt: 0, pushed: true })

  it("takes a single commit's subject", () => {
    expect(suggestPullRequest('fix/x', [commit('fix: read the clock once')])).toEqual({
      title: 'fix: read the clock once',
      body: '',
    })
  })

  it('names several after the branch and lists them oldest first', () => {
    expect(suggestPullRequest('fix/flaky-login_test', [commit('b'), commit('a')])).toEqual({
      title: 'Flaky login test',
      body: '- a\n- b',
    })
    expect(suggestPullRequest('topic', []).title).toBe('Topic')
  })
})

describe('projectRelative', () => {
  it('maps repository paths into a project inside the repository', () => {
    expect(projectRelative('/repo', '/repo', 'src/a.ts')).toBe('src/a.ts')
    expect(projectRelative('/repo', '/repo/app', 'app/src/a.ts')).toBe('src/a.ts')
    expect(projectRelative('/repo', '/repo/app', 'lib/b.ts')).toBeNull()
    expect(projectRelative('/repo', '/elsewhere', 'a.ts')).toBeNull()
  })

  it('compares Windows paths without regard to case or separators', () => {
    expect(projectRelative('C:\\Work\\Repo', 'c:\\work\\repo\\App', 'app/x.ts')).toBe('x.ts')
  })
})
