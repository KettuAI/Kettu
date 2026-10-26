import { describe, expect, it } from 'vitest'
import type { CommitSummary, GitStatus } from '@shared/git'
import {
  changedFiles,
  changesOpenFirst,
  FIRST_COMMITS,
  segmentBelow,
  timelineItems,
  type TimelineItem,
} from './timeline-model'

const changes = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0 }

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    projectPath: '/p',
    repo: { root: '/p', gitDir: '/p/.git' },
    head: { branch: 'fix/flaky-login', oid: 'a'.repeat(40), detached: false },
    upstream: { name: 'origin/fix/flaky-login', ahead: 0, behind: 0 },
    base: { name: 'origin/main', ahead: 0, behind: 0 },
    changes,
    operation: null,
    commits: [],
    remote: { name: 'origin', url: 'git@github.com:a/b.git', github: { owner: 'a', repo: 'b' } },
    defaultBranch: 'main',
    push: null,
    lastFetchedAt: null,
    updatedAt: 1,
    stale: false,
    ...overrides,
  }
}

/** Newest first, as the status lists them: the first `unpushed` are not on the upstream. */
function commits(count: number, unpushed = 0): CommitSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    oid: String(i).padStart(40, '0'),
    subject: `commit ${i}`,
    authoredAt: 1000 - i,
    pushed: i >= unpushed,
  }))
}

const kinds = (items: TimelineItem[]): string[] => items.map((item) => item.kind)
const tips = (items: TimelineItem[]): number[] =>
  items.flatMap((item, i) => (item.kind === 'commit' && item.upstreamTip ? [i] : []))

describe('timelineItems', () => {
  it('runs from what is to pull, through the work and the commits, to the base', () => {
    const items = timelineItems(
      status({
        upstream: { name: 'origin/fix/flaky-login', ahead: 1, behind: 2 },
        base: { name: 'origin/main', ahead: 2, behind: 3 },
        changes: { ...changes, unstaged: 1, untracked: 1 },
        commits: commits(2, 1),
      }),
      false,
    )
    expect(items).toEqual([
      { kind: 'incoming', count: 2 },
      { kind: 'changes', files: 2 },
      expect.objectContaining({ kind: 'commit', upstreamTip: false }),
      expect.objectContaining({ kind: 'commit', upstreamTip: false }),
      { kind: 'base', count: 3 },
    ])
  })

  it('marks where the upstream is on its newest pushed commit', () => {
    const items = timelineItems(
      status({ upstream: { name: 'o/b', ahead: 2, behind: 0 }, commits: commits(4, 2) }),
      false,
    )
    expect(tips(items)).toEqual([2])
  })

  it('marks no commit when the upstream has moved on, or nothing is pushed', () => {
    const behind = status({
      upstream: { name: 'o/b', ahead: 1, behind: 1 },
      commits: commits(3, 1),
    })
    expect(tips(timelineItems(behind, false))).toEqual([])
    const unpushed = status({
      upstream: { name: 'o/b', ahead: 2, behind: 0 },
      commits: commits(2, 2),
    })
    expect(tips(timelineItems(unpushed, false))).toEqual([])
    expect(tips(timelineItems(status({ upstream: null, commits: commits(2) }), false))).toEqual([])
  })

  it('shows the first commits and counts the rest until all are asked for', () => {
    const many = status({ commits: commits(FIRST_COMMITS + 3) })
    const first = timelineItems(many, false)
    expect(kinds(first).filter((kind) => kind === 'commit')).toHaveLength(FIRST_COMMITS)
    expect(first.at(-2)).toEqual({ kind: 'more', count: 3 })
    const all = timelineItems(many, true)
    expect(kinds(all).filter((kind) => kind === 'commit')).toHaveLength(FIRST_COMMITS + 3)
    expect(kinds(all)).not.toContain('more')
  })

  it('leaves out the base on the default branch and without one', () => {
    const onMain = status({ head: { branch: 'main', oid: 'a'.repeat(40), detached: false } })
    expect(kinds(timelineItems(onMain, false))).toEqual([])
    expect(kinds(timelineItems(status({ base: null }), false))).toEqual([])
    expect(kinds(timelineItems(status(), false))).toEqual(['base'])
  })
})

describe('segmentBelow', () => {
  it('dashes the line only below the commits to pull, and ends at the last row', () => {
    const items: TimelineItem[] = [
      { kind: 'incoming', count: 1 },
      { kind: 'changes', files: 1 },
      { kind: 'base', count: 0 },
    ]
    expect(items.map((_, i) => segmentBelow(items, i))).toEqual(['dashed', 'solid', null])
    expect(segmentBelow(items, -1)).toBeNull()
  })
})

describe('changesOpenFirst', () => {
  it('opens the changes while a merge or rebase is under way, or files conflict', () => {
    expect(changesOpenFirst(status())).toBe(false)
    expect(changesOpenFirst(status({ operation: { kind: 'rebase', step: [2, 5] } }))).toBe(true)
    expect(changesOpenFirst(status({ changes: { ...changes, conflicted: 1 } }))).toBe(true)
  })
})

describe('changedFiles', () => {
  it('counts every changed file once, conflicts included', () => {
    const all = { ...changes, staged: 1, unstaged: 2, untracked: 3, conflicted: 4 }
    expect(changedFiles(status({ changes: all }))).toBe(10)
  })
})
