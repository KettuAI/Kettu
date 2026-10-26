// The branch popover's timeline as data: which rows it shows, newest first, and how the lane
// joins them. Pure, so the rules are tested on their own.

import type { CommitSummary, GitStatus } from '@shared/git'

/** Commits shown before "N more". */
export const FIRST_COMMITS = 10

export type TimelineItem =
  | { kind: 'incoming'; count: number }
  | { kind: 'changes'; files: number }
  | { kind: 'commit'; commit: CommitSummary; upstreamTip: boolean }
  | { kind: 'more'; count: number }
  | { kind: 'base'; count: number }

/** A piece of the lane between two rows; dashed below commits the branch does not have yet. */
export type Segment = 'solid' | 'dashed' | null

export function changedFiles(status: GitStatus): number {
  const { staged, unstaged, untracked, conflicted } = status.changes
  return staged + unstaged + untracked + conflicted
}

/**
 * Commits to pull, uncommitted changes, the branch's commits, then its base. The upstream's ref
 * marks the newest pushed commit only while the branch is not behind; behind, the upstream is
 * past every commit shown, at the row of commits to pull.
 */
export function timelineItems(status: GitStatus, all: boolean): TimelineItem[] {
  const { upstream, commits, base, head, defaultBranch } = status
  const items: TimelineItem[] = []
  if (upstream && upstream.behind > 0) items.push({ kind: 'incoming', count: upstream.behind })
  const files = changedFiles(status)
  if (files > 0) items.push({ kind: 'changes', files })
  const shown = all ? commits : commits.slice(0, FIRST_COMMITS)
  const tip = upstream && upstream.behind === 0 ? commits.findIndex((c) => c.pushed) : -1
  shown.forEach((commit, i) => items.push({ kind: 'commit', commit, upstreamTip: i === tip }))
  if (shown.length < commits.length) {
    items.push({ kind: 'more', count: commits.length - shown.length })
  }
  if (base && head.branch !== defaultBranch) items.push({ kind: 'base', count: base.behind })
  return items
}

/** The lane between `items[i]` and the row after it. */
export function segmentBelow(items: readonly TimelineItem[], i: number): Segment {
  if (i < 0 || i >= items.length - 1) return null
  return items[i]!.kind === 'incoming' ? 'dashed' : 'solid'
}

/** Mid-merge or rebase, or with conflicts, the files open at once, so the conflicts show. */
export function changesOpenFirst(status: GitStatus): boolean {
  return status.operation !== null || status.changes.conflicted > 0
}
