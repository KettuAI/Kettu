import { describe, expect, it } from 'vitest'
import type { CheckRun, GitStatus, PullRequest } from '@shared/git'
import { journeyOf, nextStepOf } from './next-step'

const github = { owner: 'acme', repo: 'app' }

function status(over: Partial<GitStatus> = {}): GitStatus {
  return {
    projectPath: '/p',
    repo: { root: '/p', gitDir: '/p/.git' },
    head: { branch: 'feat/x', oid: 'a1', detached: false },
    upstream: { name: 'origin/feat/x', ahead: 0, behind: 0 },
    base: { name: 'origin/main', ahead: 0, behind: 0 },
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0 },
    operation: null,
    commits: [],
    remote: { name: 'origin', url: 'git@github.com:acme/app.git', github },
    defaultBranch: 'main',
    push: { kind: 'remote', remote: 'origin', github, branch: 'feat/x', setUpstream: false },
    lastFetchedAt: null,
    updatedAt: 0,
    stale: false,
    ...over,
  }
}

const run = (name: string, outcome: CheckRun['outcome']): CheckRun => ({
  name,
  outcome,
  url: null,
  startedAt: 1,
  completedAt: outcome === 'pending' ? null : 2,
})

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/app/pull/7',
    ...github,
    number: 7,
    title: 'feat: x',
    state: 'open',
    head: 'feat/x',
    base: 'main',
    checks: { state: 'passing', passed: 2, failed: 0, pending: 0, runs: [run('a', 'passed')] },
    review: 'approved',
    mergeable: 'clean',
    updatedAt: 0,
    author: null,
    createdAt: 0,
    mergedAt: null,
    closedAt: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    ...over,
  }
}

const failing = pr({
  checks: {
    state: 'failing',
    passed: 1,
    failed: 1,
    pending: 0,
    runs: [run('lint', 'failed'), run('test', 'passed')],
  },
})

const dirty = { staged: 0, unstaged: 3, untracked: 0, conflicted: 0, insertions: 9, deletions: 2 }

describe('the next step', () => {
  it('puts a stopped operation with conflicts before everything else', () => {
    const step = nextStepOf(
      status({
        operation: { kind: 'rebase', step: [2, 5] },
        changes: { ...dirty, conflicted: 2 },
        upstream: { name: 'origin/feat/x', ahead: 1, behind: 3 },
      }),
      failing,
      'ready',
    )
    expect(step.kind).toBe('conflicts')
    expect(step.operation).toBe('rebase')
    expect(step.primary?.action).toBe('handOffConflicts')
    expect(step.secondary?.action).toBe('copyContinue')
  })

  it('asks to continue an operation whose conflicts are resolved', () => {
    const step = nextStepOf(status({ operation: { kind: 'merge' } }), null, 'ready')
    expect(step.kind).toBe('continue')
    expect(step.primary?.action).toBe('copyContinue')
  })

  it('asks for a commit before a diverged branch, which then cannot push', () => {
    const step = nextStepOf(
      status({ changes: dirty, upstream: { name: 'origin/feat/x', ahead: 1, behind: 3 } }),
      null,
      'ready',
    )
    expect(step.kind).toBe('commit')
    expect(step.secondary).toMatchObject({
      action: 'commitAndPush',
      enabled: false,
      reason: 'diverged',
    })
  })

  it('names a commit on an unpublished branch as one that publishes', () => {
    const step = nextStepOf(
      status({
        changes: dirty,
        upstream: null,
        push: { kind: 'remote', remote: 'origin', github, branch: 'feat/x', setUpstream: true },
      }),
      null,
      'ready',
    )
    expect(step.variant).toBe('publish')
    expect(step.values.context).toBe('unpublished')
  })

  it('has the agent rebase a diverged branch, and pull is off', () => {
    const step = nextStepOf(
      status({ upstream: { name: 'origin/feat/x', ahead: 1, behind: 3 } }),
      null,
      'ready',
    )
    expect(step.kind).toBe('diverged')
    expect(step.primary?.action).toBe('handOffRebase')
    expect(step.secondary).toMatchObject({ action: 'pull', enabled: false, reason: 'diverged' })
  })

  it('pulls a branch that is only behind', () => {
    const step = nextStepOf(
      status({ upstream: { name: 'origin/feat/x', ahead: 0, behind: 2 } }),
      null,
      'ready',
    )
    expect(step.kind).toBe('pull')
    expect(step.primary).toMatchObject({ action: 'pull', count: 2 })
  })

  it('pushes before a pull request, which waits for the push', () => {
    const step = nextStepOf(
      status({ upstream: { name: 'origin/feat/x', ahead: 2, behind: 0 } }),
      null,
      'ready',
    )
    expect(step.kind).toBe('push')
    expect(step.primary).toMatchObject({ action: 'push', count: 2, enabled: true })
    expect(step.secondary).toMatchObject({
      action: 'createPr',
      enabled: false,
      reason: 'pushFirst',
    })
  })

  it('publishes an unpublished branch that has commits, and waits on one without', () => {
    const unpublished = {
      upstream: null,
      push: {
        kind: 'remote' as const,
        remote: 'origin',
        github,
        branch: 'feat/x',
        setUpstream: true,
      },
    }
    const commit = { oid: 'c1', subject: 's', authoredAt: 0, pushed: false }
    expect(nextStepOf(status({ ...unpublished, commits: [commit] }), null, 'ready').kind).toBe(
      'publishBranch',
    )
    expect(nextStepOf(status(unpublished), null, 'ready').kind).toBe('upToDate')
  })

  it('offers the pull request once the branch is pushed, through GitHub when gh cannot', () => {
    expect(nextStepOf(status(), null, 'ready')).toMatchObject({
      kind: 'createPr',
      primary: { action: 'createPr' },
      secondary: { action: 'openCompare' },
    })
    expect(nextStepOf(status(), null, 'signed-out')).toMatchObject({
      kind: 'createPr',
      variant: 'signedOut',
      primary: { action: 'openCompare' },
    })
  })

  it('has no pull request to offer on the default branch', () => {
    const onMain = status({
      head: { branch: 'main', oid: 'a1', detached: false },
      push: { kind: 'remote', remote: 'origin', github, branch: 'main', setUpstream: false },
    })
    expect(nextStepOf(onMain, null, 'ready').kind).toBe('upToDate')
  })

  it('hands failing checks to the agent', () => {
    const step = nextStepOf(status(), failing, 'ready')
    expect(step.kind).toBe('fixChecks')
    expect(step.primary?.action).toBe('handOffFix')
    expect(step.values.name).toBe('lint')
  })

  it('waits on a pull request that cannot merge yet, and says why', () => {
    const pending = pr({
      checks: { state: 'pending', passed: 1, failed: 0, pending: 1, runs: [run('a', 'pending')] },
    })
    expect(nextStepOf(status(), pending, 'ready')).toMatchObject({
      kind: 'waiting',
      variant: 'checks',
    })
    expect(nextStepOf(status(), pr({ state: 'draft' }), 'ready').variant).toBe('draft')
    expect(nextStepOf(status(), pr({ review: 'review_required' }), 'ready').variant).toBe('review')
    expect(nextStepOf(status(), pr({ mergeable: 'conflicting' }), 'ready').variant).toBe(
      'conflicts',
    )
  })

  it('merges on GitHub once checks pass, it is approved and has no conflicts', () => {
    expect(nextStepOf(status(), pr(), 'ready')).toMatchObject({
      kind: 'merge',
      primary: { action: 'mergeOnGitHub' },
    })
  })

  it('goes back to the default branch after a merge', () => {
    const merged = pr({ state: 'merged', mergedAt: 5 })
    expect(nextStepOf(status(), merged, 'ready')).toMatchObject({
      kind: 'merged',
      primary: { action: 'switchDefault' },
      secondary: { action: 'openPr' },
    })
    const onMain = status({ head: { branch: 'main', oid: 'a1', detached: false } })
    expect(nextStepOf(onMain, merged, 'ready').primary?.action).toBe('openPr')
  })

  it('publishes a repository with no remote, as far as gh lets it', () => {
    const none = status({ remote: null, upstream: null, push: { kind: 'noRemote' } })
    expect(nextStepOf(none, null, 'ready').primary).toMatchObject({
      action: 'publishRepo',
      enabled: true,
    })
    expect(nextStepOf(none, null, 'signed-out').primary).toMatchObject({
      enabled: false,
      reason: 'ghSignedOut',
    })
  })

  it('names nothing to do on a detached head', () => {
    const step = nextStepOf(
      status({ head: { branch: null, oid: 'a1', detached: true } }),
      null,
      null,
    )
    expect(step).toMatchObject({ kind: 'noBranch', variant: 'detached', primary: null })
  })
})

describe('the progress line', () => {
  it('counts what each step holds', () => {
    const steps = journeyOf(
      status({
        changes: dirty,
        upstream: { name: 'origin/feat/x', ahead: 2, behind: 0 },
        commits: [
          { oid: 'c1', subject: 'a', authoredAt: 0, pushed: false },
          { oid: 'c2', subject: 'b', authoredAt: 0, pushed: false },
          { oid: 'c3', subject: 'c', authoredAt: 0, pushed: true },
        ],
      }),
      failing,
      'ready',
    )
    expect(steps.map((s) => [s.id, s.tone, s.count])).toEqual([
      ['uncommitted', 'hold', 3],
      ['local', 'now', 2],
      ['pushed', 'done', null],
      ['pr', 'fail', null],
      ['merge', 'todo', null],
    ])
    expect(steps[3]!.values.name).toBe('lint')
  })

  it('turns the first step red for conflicts, and the third amber for commits to pull', () => {
    const steps = journeyOf(
      status({
        changes: { ...dirty, conflicted: 2 },
        upstream: { name: 'origin/feat/x', ahead: 1, behind: 3 },
      }),
      null,
      'ready',
    )
    expect(steps[0]).toMatchObject({ tone: 'fail', label: 'conflicts', count: 2 })
    expect(steps[2]).toMatchObject({ tone: 'hold', label: 'toPull', count: 3 })
  })

  it('ends purple once the pull request merged, and blue when it can merge', () => {
    expect(journeyOf(status(), pr({ state: 'merged', mergedAt: 9 }), 'ready')[4]).toMatchObject({
      tone: 'merged',
      at: 9,
    })
    expect(journeyOf(status(), pr(), 'ready')[4]).toMatchObject({ tone: 'now', note: 'ready' })
  })

  it('says why a pull request is missing when gh cannot show it', () => {
    expect(journeyOf(status(), null, 'signed-out')[3]!.note).toBe('signIn')
    expect(journeyOf(status(), null, 'not-installed')[3]!.note).toBe('installGh')
  })
})
