import { describe, expect, it } from 'vitest'
import type { GitStatus } from '@shared/git'
import { failureNote, offersPullRequest, successNote } from './results'

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    projectPath: '/p',
    repo: { root: '/p', gitDir: '/p/.git' },
    head: { branch: 'fix/day-key', oid: 'a'.repeat(40), detached: false },
    upstream: { name: 'origin/fix/day-key', ahead: 0, behind: 0 },
    base: { name: 'origin/main', ahead: 2, behind: 0 },
    changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0 },
    operation: null,
    commits: [],
    remote: { name: 'origin', url: 'git@github.com:a/b.git', github: { owner: 'a', repo: 'b' } },
    defaultBranch: 'main',
    push: {
      kind: 'remote',
      remote: 'origin',
      github: { owner: 'a', repo: 'b' },
      branch: 'fix/day-key',
      setUpstream: false,
    },
    lastFetchedAt: null,
    updatedAt: 1,
    stale: false,
    ...overrides,
  }
}

const upstream = (ahead: number, behind: number) => ({
  upstream: { name: 'origin/fix/day-key', ahead, behind },
})

describe('successNote', () => {
  it('says a fetch brought nothing, or how much there is to pull', () => {
    expect(successNote({ kind: 'fetch' }, status(), status(), false)).toMatchObject({
      key: 'result.fetchedNothing',
      values: { branch: 'main' },
      tone: 'info',
      next: null,
    })
    expect(successNote({ kind: 'fetch' }, status(), status(upstream(0, 3)), false)).toMatchObject({
      key: 'result.fetchedNew',
      values: { count: 3, branch: 'fix/day-key' },
      next: 'pull',
    })
  })

  it('counts what a fetch brought to the default branch', () => {
    const base = (behind: number) => ({ base: { name: 'origin/main', ahead: 2, behind } })
    expect(successNote({ kind: 'fetch' }, status(base(1)), status(base(4)), false)).toMatchObject({
      key: 'result.fetchedNew',
      values: { count: 3, branch: 'main' },
      next: null,
    })
    expect(successNote({ kind: 'fetch' }, status(base(4)), status(base(4)), false)).toMatchObject({
      key: 'result.fetchedNothing',
      values: { branch: 'main' },
    })
  })

  it('names the upstream after a fetch on the default branch itself', () => {
    const onMain = {
      head: { branch: 'main', oid: 'a'.repeat(40), detached: false },
      upstream: { name: 'origin/main', ahead: 0, behind: 0 },
      base: null,
    }
    expect(successNote({ kind: 'fetch' }, status(onMain), status(onMain), false)).toMatchObject({
      key: 'result.fetchedNothing',
      values: { branch: 'main' },
    })
  })

  it('names no branch for a commit on a detached HEAD', () => {
    const commit = { kind: 'commit' as const, message: 'm', paths: ['a', 'b'] }
    const detached = { head: { branch: null, oid: 'a'.repeat(40), detached: true } }
    expect(successNote(commit, status(), status(detached), false)).toMatchObject({
      key: 'result.committedDetached',
      values: { count: 2 },
      next: null,
    })
  })

  it('counts a push from the status before it and offers a pull request next', () => {
    const push = { kind: 'push', remote: 'origin', branch: 'fix/day-key' } as const
    expect(successNote(push, status(upstream(2, 0)), status(), false)).toMatchObject({
      key: 'result.pushed',
      values: { count: 2, remote: 'origin' },
      tone: 'success',
      next: 'createPr',
    })
  })

  it('offers no pull request when there is one, or on the default branch', () => {
    const push = { kind: 'push', remote: 'origin', branch: 'main' } as const
    expect(successNote(push, status(upstream(1, 0)), status(), true).next).toBeNull()
    const onMain = status({ head: { branch: 'main', oid: 'a'.repeat(40), detached: false } })
    expect(successNote(push, onMain, onMain, false).next).toBeNull()
  })

  it('offers Push after a commit', () => {
    expect(
      successNote({ kind: 'commit', message: 'm', paths: ['a', 'b'] }, status(), status(), false),
    ).toMatchObject({ key: 'result.committed', values: { count: 2 }, next: 'push' })
  })

  it('says a pull brought nothing when HEAD did not move', () => {
    expect(successNote({ kind: 'pull' }, status(), status(), false)).toMatchObject({
      key: 'result.pulledNothing',
      values: { branch: 'fix/day-key' },
      tone: 'info',
      next: null,
    })
    const moved = { head: { branch: 'fix/day-key', oid: 'b'.repeat(40), detached: false } }
    expect(
      successNote({ kind: 'pull' }, status(upstream(0, 2)), status(moved), false),
    ).toMatchObject({ key: 'result.pulled', values: { count: 2 }, tone: 'success' })
  })

  it('names a single discarded file', () => {
    expect(
      successNote({ kind: 'discard', paths: ['src/a/b.ts'] }, status(), status(), false),
    ).toMatchObject({ key: 'result.discardedOne', values: { name: 'b.ts' } })
  })
})

describe('failureNote', () => {
  it('offers Pull and retry for a rejected push', () => {
    const push = { kind: 'push', remote: 'origin', branch: 'fix/day-key' } as const
    const log = ' ! [rejected]        fix/day-key -> fix/day-key (fetch first)'
    expect(failureNote(push, log, false)).toMatchObject({
      key: 'result.pushRejected',
      values: { remote: 'origin' },
      tone: 'warning',
      next: 'pullAndRetry',
    })
  })

  it('names the operation and offers the log for other failures', () => {
    expect(failureNote({ kind: 'pull' }, 'fatal: unable to access remote', false)).toMatchObject({
      key: 'failure.network',
      operation: 'pull',
      next: 'showLog',
    })
    expect(failureNote({ kind: 'commit', message: 'm', paths: ['a'] }, '', false)).toMatchObject({
      key: 'failure.other',
      operation: 'commit',
      next: null,
    })
  })

  it('says another operation is running', () => {
    expect(failureNote({ kind: 'fetch' }, 'busy', true)).toMatchObject({ key: 'failure.busy' })
  })
})

describe('offersPullRequest', () => {
  it('needs a GitHub remote', () => {
    expect(offersPullRequest(status({ remote: null }), false)).toBe(false)
    expect(offersPullRequest(status(), false)).toBe(true)
  })
})
