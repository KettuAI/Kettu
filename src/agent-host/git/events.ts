// Turns the difference between two statuses into the git entries of a session's thread.

import type { GitStatus } from '@shared/git'
import type { ToolKind } from '@shared/thread'
import type { GitEventDraft } from './api'
import { expectOk, GIT_TIMEOUT_MS, type Exec } from './exec'
import { parseLog } from './parse'

/** Tool kinds that can change a repository; others never refresh or produce events. */
const REPOSITORY_TOOL_KINDS: ReadonlySet<ToolKind> = new Set([
  'edit',
  'delete',
  'move',
  'execute',
  'other',
])

export function canChangeRepository(kind: ToolKind): boolean {
  return REPOSITORY_TOOL_KINDS.has(kind)
}

const MAX_LISTED_COMMITS = 3
const NEW_COMMIT_LIMIT = 200
const SCANNED_OUTPUT_LIMIT = 1024 * 1024
const PULL_REQUEST_IN_TEXT = /(?<![\w/])https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g

export interface NewCommit {
  oid: string
  subject: string
}

/**
 * Commits that are on `to` but not on `from` and were committed at or after `sinceSeconds`.
 * The time filter keeps commits that arrived from elsewhere, by a pull or a checkout, out of
 * the list; only commits made during the tool call count.
 */
export async function listNewCommits(
  exec: Exec,
  cwd: string,
  from: string | null,
  to: string,
  sinceSeconds: number,
): Promise<NewCommit[]> {
  const result = await exec(
    'git',
    [
      'log',
      '-n',
      String(NEW_COMMIT_LIMIT),
      '--no-show-signature',
      '--encoding=UTF-8',
      '--format=%H%x00%s%x00%ct',
      from === null ? to : `${from}..${to}`,
      '--',
    ],
    { cwd, timeoutMs: GIT_TIMEOUT_MS },
  )
  return parseLog(expectOk('git log', result).stdout)
    .filter((line) => line.time >= sinceSeconds)
    .map(({ oid, subject }) => ({ oid, subject }))
}

/** The last pull request URL in a tool's output, which is where `gh pr create` prints it. */
export function extractPullRequestUrl(output: string): string | null {
  const text = output.length > SCANNED_OUTPUT_LIMIT ? output.slice(-SCANNED_OUTPUT_LIMIT) : output
  let last: string | null = null
  for (const match of text.matchAll(PULL_REQUEST_IN_TEXT)) {
    last = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`
  }
  return last
}

export interface EventInput {
  before: GitStatus
  after: GitStatus
  /** From `listNewCommits` between the two statuses, newest first. */
  newCommits: readonly NewCommit[]
  /** The tool's output, or an empty string for a tool that cannot open a pull request. */
  output: string
}

/** Branch, commit, push and pull request events, in the order they happen in a workflow. */
export function computeGitEvents({
  before,
  after,
  newCommits,
  output,
}: EventInput): GitEventDraft[] {
  const events: GitEventDraft[] = []
  if (before.repo === null || after.repo === null || after.stale) return events

  // A switch from a detached head is not reported: a finished rebase looks the same.
  if (
    before.head.branch !== null &&
    after.head.branch !== null &&
    before.head.branch !== after.head.branch
  ) {
    events.push({ kind: 'git', event: 'branch', branch: after.head.branch })
  }

  if (newCommits.length > 0) {
    events.push({
      kind: 'git',
      event: 'commit',
      commits: newCommits.slice(0, MAX_LISTED_COMMITS),
      more: Math.max(0, newCommits.length - MAX_LISTED_COMMITS),
    })
  }

  const push = detectPush(before, after, newCommits)
  if (push) events.push({ kind: 'git', event: 'push', ...push })

  const url = extractPullRequestUrl(output)
  if (url) events.push({ kind: 'git', event: 'pull_request', url })
  return events
}

function detectPush(
  before: GitStatus,
  after: GitStatus,
  newCommits: readonly NewCommit[],
): { upstream: string; count: number } | null {
  const upstream = after.upstream
  if (!upstream) return null

  if (before.head.branch !== after.head.branch) {
    // After a switch, the new branch's own upstream says nothing; only commits made
    // during the call that are already on the upstream were pushed by it.
    const made = new Set(newCommits.map((commit) => commit.oid))
    const count = after.commits.filter((commit) => commit.pushed && made.has(commit.oid)).length
    return count > 0 ? { upstream: upstream.name, count } : null
  }

  if (before.upstream?.name === upstream.name) {
    // Commits that were unpushed or made now, minus the ones still unpushed. This also
    // sees a commit that was pushed in the same call.
    const count = before.upstream.ahead + newCommits.length - upstream.ahead
    return count > 0 ? { upstream: upstream.name, count } : null
  }

  // The branch gained an upstream, which is a push even when no commit is listed.
  const published = after.commits.filter((commit) => commit.pushed).length
  return { upstream: upstream.name, count: published > 0 ? published : newCommits.length }
}
