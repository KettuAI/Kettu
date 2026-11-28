import { describe, expect, it, vi } from 'vitest'
import type { Exec, ExecResult } from './exec'
import { classifyReferenceSearchFailure, searchRepositoryReferences } from './gh'
import {
  mapRepositoryReferences,
  recentReferencesArgs,
  sanitizeReferenceSearchTerms,
  searchReferencesArgs,
} from './github'
import { createGitService } from './service'

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '', failure: null, message: '' }
}

function fail(partial: Partial<ExecResult>): ExecResult {
  return {
    code: 1,
    stdout: '',
    stderr: '',
    failure: null,
    message: '',
    ...partial,
  }
}

describe('repository reference search GraphQL helpers (#2600)', () => {
  it('builds read-only recent, title search, and numeric lookup GraphQL arguments', () => {
    const recent = recentReferencesArgs('KettuAI', 'Kettu')
    expect(recent.slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'github.com'])
    expect(recent).toContain('owner=KettuAI')
    expect(recent).toContain('repo=Kettu')
    expect(searchReferencesArgs('KettuAI', 'Kettu', '   ')).toEqual(recent)

    const byTitle = searchReferencesArgs('KettuAI', 'Kettu', 'hash picker')
    expect(byTitle).toContain('searchQuery=repo:KettuAI/Kettu "hash" "picker" in:title')
    expect(byTitle.some((a) => a.startsWith('number='))).toBe(false)

    const byNumber = searchReferencesArgs('KettuAI', 'Kettu', '2600')
    expect(byNumber).toContain('owner=KettuAI')
    expect(byNumber).toContain('repo=Kettu')
    expect(byNumber).toContain('number=2600')
    expect(byNumber).toContain('searchQuery=repo:KettuAI/Kettu "2600" in:title')
  })

  it('sanitizes control characters, quotes, and qualifier colons from search terms', () => {
    expect(sanitizeReferenceSearchTerms('org:evil "fix"\\n\tbug')).toBe(
      '"org" "evil" "fix" "n" "bug"',
    )
    expect(sanitizeReferenceSearchTerms('"""   :::')).toBe('')
  })

  it('maps issues and pull requests with accurate states, deduplicates, and drops foreign repos', () => {
    const items = mapRepositoryReferences(
      {
        data: {
          repository: {
            issueOrPullRequest: {
              __typename: 'Issue',
              number: 2600,
              title: 'Support # picker',
              url: 'https://github.com/KettuAI/Kettu/issues/2600',
              state: 'OPEN',
              stateReason: null,
              updatedAt: '2026-11-27T10:00:00Z',
            },
            issues: {
              nodes: [
                {
                  __typename: 'Issue',
                  number: 2600,
                  title: 'Duplicate ignored',
                  url: 'https://github.com/KettuAI/Kettu/issues/2600',
                  state: 'OPEN',
                  updatedAt: '2026-11-26T10:00:00Z',
                },
                {
                  __typename: 'Issue',
                  number: 2500,
                  title: 'Completed issue',
                  url: 'https://github.com/KettuAI/Kettu/issues/2500',
                  state: 'CLOSED',
                  stateReason: 'COMPLETED',
                  updatedAt: '2026-11-27T12:00:00Z',
                },
                {
                  __typename: 'Issue',
                  number: 2499,
                  title: 'Not planned issue',
                  url: 'https://github.com/KettuAI/Kettu/issues/2499',
                  state: 'CLOSED',
                  stateReason: 'NOT_PLANNED',
                  updatedAt: '2026-11-25T12:00:00Z',
                },
                {
                  __typename: 'Issue',
                  number: 99,
                  title: 'Foreign repo leak',
                  url: 'https://github.com/other/repo/issues/99',
                  state: 'OPEN',
                  updatedAt: '2026-11-27T15:00:00Z',
                },
              ],
            },
            pullRequests: {
              nodes: [
                {
                  __typename: 'PullRequest',
                  number: 2652,
                  title: 'Recognize schemeless github links',
                  url: 'https://github.com/KettuAI/Kettu/pull/2652',
                  state: 'MERGED',
                  isDraft: false,
                  updatedAt: '2026-11-27T14:00:00Z',
                },
                {
                  __typename: 'PullRequest',
                  number: 2700,
                  title: 'Draft work',
                  url: 'https://github.com/KettuAI/Kettu/pull/2700',
                  state: 'OPEN',
                  isDraft: true,
                  updatedAt: '2026-11-27T11:00:00Z',
                },
              ],
            },
          },
        },
      },
      'kettuai',
      'kettu',
    )

    expect(
      items.map((item) => ({ kind: item.kind, number: item.number, state: item.state })),
    ).toEqual([
      { kind: 'pull', number: 2652, state: 'merged' },
      { kind: 'issue', number: 2500, state: 'completed' },
      { kind: 'pull', number: 2700, state: 'draft' },
      { kind: 'issue', number: 2600, state: 'open' },
      { kind: 'issue', number: 2499, state: 'not_planned' },
    ])
  })
})

describe('searchRepositoryReferences fault tolerance (#2600)', () => {
  it('accepts partial GraphQL responses when only issueOrPullRequest(number) is NOT_FOUND', async () => {
    const exec: Exec = async () =>
      fail({
        code: 1,
        stdout: JSON.stringify({
          data: {
            repository: { issueOrPullRequest: null },
            search: {
              nodes: [
                {
                  __typename: 'Issue',
                  number: 2844,
                  title: 'Stacked PRs (related to #2600)',
                  url: 'https://github.com/KettuAI/Kettu/issues/2844',
                  state: 'CLOSED',
                  stateReason: 'COMPLETED',
                  updatedAt: '2026-11-27T12:00:00Z',
                },
              ],
            },
          },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['repository', 'issueOrPullRequest'],
              message: 'Could not resolve to an issue or pull request with the number of 9999999.',
            },
          ],
        }),
        stderr: 'gh: Could not resolve to an issue or pull request with the number of 9999999.',
      })

    const result = await searchRepositoryReferences(exec, 'KettuAI', 'Kettu', '9999999', '/tmp')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.items.map((i) => i.number)).toEqual([2844])
    }
  })

  it('classifies missing gh, signed-out gh, timeout, and general failures cleanly', async () => {
    const cases: [ExecResult, ReturnType<typeof classifyReferenceSearchFailure>][] = [
      [fail({ code: null, failure: 'not-found', message: 'ENOENT' }), 'gh-missing'],
      [fail({ stderr: 'gh: Bad credentials (HTTP 401)' }), 'gh-signed-out'],
      [
        fail({ stderr: 'To get started with GitHub CLI, please run: gh auth login' }),
        'gh-signed-out',
      ],
      [fail({ code: null, failure: 'timeout', message: 'timed out' }), 'timeout'],
      [fail({ stderr: 'gh: HTTP 500' }), 'failed'],
    ]

    for (const [execResult, expected] of cases) {
      expect(classifyReferenceSearchFailure(execResult)).toBe(expected)
      const outcome = await searchRepositoryReferences(
        async () => execResult,
        'KettuAI',
        'Kettu',
        '',
        '/tmp',
      )
      expect(outcome).toMatchObject({ kind: 'unavailable', reason: expected })
    }
  })
})

describe('GitService.searchReferences caching, auth recovery, and coalescing (#2600)', () => {
  function toolsExec(
    onApi: (args: readonly string[]) => Promise<ExecResult> | ExecResult,
    ghState: () => 'ready' | 'signed-out' | 'not-installed' = () => 'ready',
  ): Exec {
    return async (file, args) => {
      if (file === 'git' && args[0] === '--version') return ok('git version 2.50.0\n')
      if (file === 'gh' && args[0] === '--version') {
        return ghState() === 'not-installed'
          ? fail({ code: null, failure: 'not-found', message: 'ENOENT' })
          : ok('gh version 2.105.0\n')
      }
      if (file === 'gh' && args[0] === 'auth') {
        return ghState() === 'ready'
          ? ok('github.com\n  Logged in to github.com account octocat\n')
          : fail({ stderr: 'You are not logged into any GitHub hosts.' })
      }
      if (file === 'gh' && args[0] === 'api') return onApi(args)
      return fail({ stderr: `unexpected command: ${file} ${args.join(' ')}` })
    }
  }

  const samplePayload = ok(
    JSON.stringify({
      data: {
        repository: {
          issues: {
            nodes: [
              {
                __typename: 'Issue',
                number: 2600,
                title: 'Hash reference picker',
                url: 'https://github.com/KettuAI/Kettu/issues/2600',
                state: 'OPEN',
                stateReason: null,
                updatedAt: '2026-11-27T10:00:00Z',
              },
            ],
          },
          pullRequests: { nodes: [] },
        },
      },
    }),
  )

  it('skips gh api when gh is signed out or missing and recovers after reloadTools', async () => {
    let state: 'ready' | 'signed-out' | 'not-installed' = 'signed-out'
    const apiCalls = vi.fn(() => samplePayload)
    const service = createGitService(
      { env: {}, log: () => {} },
      { exec: toolsExec(apiCalls, () => state) },
    )
    try {
      expect(await service.searchReferences('KettuAI', 'Kettu', '')).toEqual({
        kind: 'unavailable',
        reason: 'gh-signed-out',
      })
      expect(apiCalls).not.toHaveBeenCalled()

      state = 'ready'
      await service.reloadTools()
      const recovered = await service.searchReferences('KettuAI', 'Kettu', '')
      expect(recovered.kind).toBe('ok')
      expect(apiCalls).toHaveBeenCalledTimes(1)
    } finally {
      await service.dispose()
    }
  })

  it('caches results for 60s and coalesces concurrent identical searches', async () => {
    let clock = 1_000_000
    let resolveApi!: (r: ExecResult) => void
    const apiCalls = vi.fn(
      () =>
        new Promise<ExecResult>((resolve) => {
          resolveApi = resolve
        }),
    )
    const service = createGitService(
      { env: {}, log: () => {} },
      { exec: toolsExec(apiCalls), now: () => clock },
    )
    try {
      const a = service.searchReferences('KettuAI', 'Kettu', '')
      const b = service.searchReferences('kettuai', 'kettu', '  ')
      await new Promise((r) => setTimeout(r, 10))
      resolveApi(samplePayload)
      const [ra, rb] = await Promise.all([a, b])
      expect(ra).toEqual(rb)
      expect(apiCalls).toHaveBeenCalledTimes(1)

      // Still cached 30 seconds later.
      clock += 30_000
      const cached = await service.searchReferences('KettuAI', 'Kettu', '')
      expect(cached).toEqual(ra)
      expect(apiCalls).toHaveBeenCalledTimes(1)

      // Refreshes after 60 seconds.
      clock += 35_000
      const refreshedPromise = service.searchReferences('KettuAI', 'Kettu', '')
      await new Promise((r) => setTimeout(r, 10))
      resolveApi(samplePayload)
      const refreshed = await refreshedPromise
      expect(refreshed.kind).toBe('ok')
      expect(apiCalls).toHaveBeenCalledTimes(2)
    } finally {
      await service.dispose()
    }
  })
})
