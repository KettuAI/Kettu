// Shared setup for the service tests: a service over real git and an in-process fake gh.

import type { GitStatus } from '@shared/git'
import type { GitServiceApi } from './api'
import type { Exec, ExecResult } from './exec'
import { createGitService, type GitServiceOptions } from './service'
import type { Sandbox } from './test-support'

export function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', failure: null, message: '', ...overrides }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (condition()) return true
    await sleep(20)
  }
  return condition()
}

export interface FakeGh {
  installed: boolean
  signedIn: boolean
  account: string
  /** What `gh pr view` answers for the current branch; null: no pull request. */
  view: object | null
  list: object[]
  byUrl: Record<string, object>
  /** What `gh api users/<login>` answers, by login; a missing login is a 404. */
  users: Record<string, object>
  /** When set, `gh pr view` and `gh pr list` fail with this message. */
  error: string | null
  /** Does what `gh repo create` would in the folder; null: the command fails. */
  onRepoCreate: ((root: string) => Promise<void>) | null
  /** What `gh pr create` opens; null: the command fails. */
  created: { url: string } | null
  /** `gh pr view` cannot find the pull request just created, as right after creation. */
  createdUnseen: boolean
  calls: string[][]
  /** Calls that were not `--version` or `auth status`. */
  pullRequestCalls(): string[][]
}

export function pullRequestJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: 'feat: twelve',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/acme/app/pull/12',
    headRefName: 'feat/twelve',
    baseRefName: 'main',
    reviewDecision: 'REVIEW_REQUIRED',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    updatedAt: '2026-10-20T08:00:00Z',
    ...overrides,
  }
}

/** Runs git for real and answers gh from memory. */
export function createFakeGh(real: Exec): { gh: FakeGh; exec: Exec; gitCalls: string[][] } {
  const gitCalls: string[][] = []
  const gh: FakeGh = {
    installed: true,
    signedIn: true,
    account: 'octocat',
    view: null,
    list: [],
    byUrl: {},
    users: {},
    error: null,
    onRepoCreate: null,
    created: null,
    createdUnseen: false,
    calls: [],
    pullRequestCalls: () => gh.calls.filter((call) => call[0] === 'pr'),
  }
  const exec: Exec = async (file, args, options) => {
    if (file !== 'gh') {
      gitCalls.push([...args])
      return real(file, args, options)
    }
    gh.calls.push([...args])
    if (!gh.installed)
      return result({ code: null, failure: 'not-found', message: 'spawn gh ENOENT' })
    if (args[0] === '--version') return result({ stdout: 'gh version 2.98.0 (2026-08-20)\n' })
    if (args[0] === 'auth') {
      return gh.signedIn
        ? result({
            stdout: `github.com\n  \u2713 Logged in to github.com account ${gh.account} (keyring)\n`,
          })
        : result({ code: 1, stderr: 'You are not logged into any GitHub hosts.' })
    }
    if (args[0] === 'pr' && gh.error !== null) return result({ code: 1, stderr: gh.error })
    if (args[0] === 'pr' && args[1] === 'view') {
      const target = args[2]
      if (target && !target.startsWith('--')) {
        const found = gh.byUrl[target]
        return found
          ? result({ stdout: JSON.stringify(found) })
          : result({ code: 1, stderr: `GraphQL: Could not resolve to a PullRequest (${target})` })
      }
      return gh.view
        ? result({ stdout: JSON.stringify(gh.view) })
        : result({ code: 1, stderr: 'no pull requests found for branch "x"\n' })
    }
    if (args[0] === 'pr' && args[1] === 'list') return result({ stdout: JSON.stringify(gh.list) })
    if (args[0] === 'api') {
      const user = gh.users[args.at(-1)?.replace(/^users\//, '') ?? '']
      return user
        ? result({ stdout: JSON.stringify(user) })
        : result({ code: 1, stderr: 'gh: Not Found (HTTP 404)' })
    }
    if (args[0] === 'repo' && args[1] === 'create') {
      if (!gh.onRepoCreate) return result({ code: 1, stderr: 'GraphQL: Name already exists' })
      await gh.onRepoCreate(options.cwd ?? '')
      return result({ stdout: 'https://github.com/acme/new\n', stderr: 'Created repository\n' })
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      if (!gh.created) return result({ code: 1, stderr: 'GraphQL: No commits between main and x' })
      if (!gh.createdUnseen) {
        gh.byUrl[gh.created.url] = gh.created
        gh.view = gh.created
      }
      return result({ stdout: `${gh.created.url}\n`, stderr: 'Creating pull request\n' })
    }
    return result({ code: 1, stderr: `unexpected gh call: ${args.join(' ')}` })
  }
  return { gh, exec, gitCalls }
}

export interface TestService {
  svc: GitServiceApi
  gh: FakeGh
  gitCalls: string[][]
  logs: string[]
  statuses: GitStatus[]
}

export function createTestService(
  s: Sandbox,
  services: GitServiceApi[],
  extra: GitServiceOptions = {},
): TestService {
  const logs: string[] = []
  const statuses: GitStatus[] = []
  const fake = createFakeGh(s.exec)
  const svc = createGitService(
    { env: s.env, log: (level, message) => logs.push(`${level}: ${message}`) },
    { exec: fake.exec, ...extra },
  )
  svc.onChanged((status) => statuses.push(status))
  services.push(svc)
  return { svc, gh: fake.gh, gitCalls: fake.gitCalls, logs, statuses }
}
