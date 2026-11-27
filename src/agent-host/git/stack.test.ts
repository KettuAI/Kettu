import { describe, expect, it, vi } from 'vitest'
import type { Exec, ExecResult } from './exec'
import { classifyStackFailure, viewPullRequestStackByUrl } from './gh'
import { GITHUB_STACKS_API_VERSION, mapPullRequestStack, stackArgs } from './github'
import { createGitService } from './service'

const STACK_URL = 'https://github.com/acme/app/stacks/42'

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

describe('stackArgs and mapPullRequestStack (#2844)', () => {
  it('builds read-only gh api arguments with the Stacks API version header', () => {
    expect(stackArgs(STACK_URL)).toEqual([
      'api',
      '--hostname',
      'github.com',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      `X-GitHub-Api-Version: ${GITHUB_STACKS_API_VERSION}`,
      'repos/acme/app/stacks/42',
    ])
    expect(() => stackArgs('https://github.com/acme/app/pull/42')).toThrow()
    expect(() => stackArgs('https://github.com/acme/app/stacks/0')).toThrow()
  })

  it('maps a full REST stack payload with ordered PR states, branches, and optional titles', () => {
    const stack = mapPullRequestStack(
      {
        id: 9876543,
        number: 42,
        open: true,
        base: { ref: 'main' },
        created_at: '2026-04-15T10:00:00Z',
        updated_at: '2026-04-16T12:30:00Z',
        pull_requests: [
          {
            number: 101,
            state: 'closed',
            draft: false,
            merged_at: '2026-04-16T11:00:00Z',
            head: { ref: 'feat/model', sha: 'aaa' },
            html_url: 'https://github.com/acme/app/pull/101',
          },
          {
            number: 102,
            state: 'open',
            draft: false,
            merged_at: null,
            head: { ref: 'feat/api', sha: 'bbb' },
            title: 'Expose stack endpoints',
          },
          {
            number: 103,
            state: 'open',
            draft: true,
            merged_at: null,
            head: { ref: 'feat/ui', sha: 'ccc' },
            html_url: 'https://api.github.com/repos/acme/app/pulls/103',
          },
          {
            number: 104,
            state: 'closed',
            draft: false,
            merged_at: null,
            head: { ref: 'feat/dropped', sha: 'ddd' },
          },
        ],
      },
      STACK_URL,
    )

    expect(stack).toEqual({
      url: STACK_URL,
      owner: 'acme',
      repo: 'app',
      number: 42,
      title: null,
      state: 'open',
      base: 'main',
      createdAt: Date.parse('2026-04-15T10:00:00Z'),
      updatedAt: Date.parse('2026-04-16T12:30:00Z'),
      pullRequests: [
        {
          number: 101,
          url: 'https://github.com/acme/app/pull/101',
          state: 'merged',
          head: 'feat/model',
          title: null,
        },
        {
          number: 102,
          url: 'https://github.com/acme/app/pull/102',
          state: 'open',
          head: 'feat/api',
          title: 'Expose stack endpoints',
        },
        {
          number: 103,
          url: 'https://github.com/acme/app/pull/103',
          state: 'draft',
          head: 'feat/ui',
          title: null,
        },
        {
          number: 104,
          url: 'https://github.com/acme/app/pull/104',
          state: 'closed',
          head: 'feat/dropped',
          title: null,
        },
      ],
    })
  })

  it('tolerates missing optional preview fields and skips malformed or duplicate PR entries', () => {
    const stack = mapPullRequestStack(
      {
        title: 'Auth refactor',
        state: 'closed',
        pull_requests: [
          null,
          { number: 0, state: 'open' },
          { number: 201, state: 'closed', merged_at: '2026-05-01T00:00:00Z' },
          { number: 201, state: 'open' },
        ],
      },
      STACK_URL,
    )

    expect(stack).toEqual({
      url: STACK_URL,
      owner: 'acme',
      repo: 'app',
      number: 42,
      title: 'Auth refactor',
      state: 'closed',
      base: null,
      createdAt: null,
      updatedAt: null,
      pullRequests: [
        {
          number: 201,
          url: 'https://github.com/acme/app/pull/201',
          state: 'merged',
          head: null,
          title: null,
        },
      ],
    })
  })

  it('rejects non-stack payloads so callers can fall back cleanly', () => {
    expect(() => mapPullRequestStack(null, STACK_URL)).toThrow()
    expect(() => mapPullRequestStack({}, STACK_URL)).toThrow()
    expect(() => mapPullRequestStack({ message: 'Not Found', status: '404' }, STACK_URL)).toThrow()
    expect(() =>
      mapPullRequestStack({ open: true, pull_requests: 'not-an-array' }, STACK_URL),
    ).toThrow()
  })
})

describe('viewPullRequestStackByUrl graceful degradation (#2844)', () => {
  it('classifies 404, 403, 401/signed-out, gh-missing, timeout, and malformed payloads cleanly', async () => {
    const cases: [ExecResult, ReturnType<typeof classifyStackFailure>][] = [
      [fail({ stderr: 'gh: Not Found (HTTP 404)' }), 'not-found'],
      [fail({ stderr: 'gh: Forbidden (HTTP 403)' }), 'forbidden'],
      [fail({ stderr: 'Resource not accessible by integration' }), 'forbidden'],
      [fail({ stderr: 'gh: Bad credentials (HTTP 401)' }), 'gh-signed-out'],
      [
        fail({ stderr: 'To get started with GitHub CLI, please run: gh auth login' }),
        'gh-signed-out',
      ],
      [fail({ code: null, failure: 'not-found', message: 'ENOENT' }), 'gh-missing'],
      [fail({ code: null, failure: 'timeout', message: 'timed out after 10000 ms' }), 'timeout'],
      [fail({ stderr: 'gh: Internal Server Error (HTTP 500)' }), 'unavailable'],
    ]

    for (const [result, expected] of cases) {
      expect(classifyStackFailure(result)).toBe(expected)
      const exec: Exec = async () => result
      expect(await viewPullRequestStackByUrl(exec, STACK_URL, '/tmp')).toEqual({
        kind: 'unavailable',
        reason: expected,
      })
    }

    // Invalid JSON or missing preview fields degrade to unavailable instead of throwing.
    const badJson: Exec = async () => ok('not json')
    expect(await viewPullRequestStackByUrl(badJson, STACK_URL, '/tmp')).toEqual({
      kind: 'unavailable',
      reason: 'unavailable',
    })

    const missingFields: Exec = async () => ok(JSON.stringify({ message: 'Preview disabled' }))
    expect(await viewPullRequestStackByUrl(missingFields, STACK_URL, '/tmp')).toEqual({
      kind: 'unavailable',
      reason: 'unavailable',
    })
  })
})

describe('GitService.stack caching, auth handling, and throttling (#2844)', () => {
  function readyToolsExec(
    onApi: (args: readonly string[]) => Promise<ExecResult> | ExecResult,
    ghSignedIn = true,
  ): Exec {
    return async (file, args) => {
      if (file === 'git' && args[0] === '--version') return ok('git version 2.50.0\n')
      if (file === 'gh' && args[0] === '--version') return ok('gh version 2.105.0\n')
      if (file === 'gh' && args[0] === 'auth') {
        return ghSignedIn
          ? ok('github.com\n  Logged in to github.com account octocat\n')
          : fail({ stderr: 'You are not logged into any GitHub hosts.' })
      }
      if (file === 'gh' && args[0] === 'api') return onApi(args)
      return fail({ stderr: `unexpected command: ${file} ${args.join(' ')}` })
    }
  }

  it('does not invoke gh api when gh is signed out and recovers after reloadTools', async () => {
    let signedIn = false
    const apiCalls = vi.fn(() =>
      ok(
        JSON.stringify({
          number: 42,
          open: true,
          base: { ref: 'main' },
          pull_requests: [{ number: 101, state: 'open', head: { ref: 'feat/a' } }],
        }),
      ),
    )
    const service = createGitService(
      {
        env: {},
        log: () => {},
      },
      {
        exec: async (file, args, options) =>
          readyToolsExec(apiCalls, signedIn)(file, args, options),
      },
    )

    try {
      expect(await service.stack(STACK_URL)).toEqual({
        kind: 'unavailable',
        reason: 'gh-signed-out',
      })
      expect(apiCalls).not.toHaveBeenCalled()

      signedIn = true
      await service.reloadTools()
      const found = await service.stack(STACK_URL)
      expect(found.kind).toBe('stack')
      expect(apiCalls).toHaveBeenCalledTimes(1)
    } finally {
      await service.dispose()
    }
  })

  it('caches 404/403 responses for 10 minutes without re-querying unless fresh=true', async () => {
    let clock = 1_000_000
    let respondWithStack = false
    const apiCalls = vi.fn(() =>
      respondWithStack
        ? ok(
            JSON.stringify({
              number: 42,
              open: true,
              base: { ref: 'main' },
              pull_requests: [],
            }),
          )
        : fail({ stderr: 'gh: Not Found (HTTP 404)' }),
    )
    const service = createGitService(
      { env: {}, log: () => {} },
      { exec: readyToolsExec(apiCalls), now: () => clock },
    )

    try {
      expect(await service.stack(STACK_URL)).toEqual({
        kind: 'unavailable',
        reason: 'not-found',
      })
      expect(apiCalls).toHaveBeenCalledTimes(1)

      // Still cached 5 minutes later (within 10-minute unreadable backoff).
      clock += 5 * 60_000
      expect(await service.stack(STACK_URL)).toEqual({
        kind: 'unavailable',
        reason: 'not-found',
      })
      expect(apiCalls).toHaveBeenCalledTimes(1)

      // Explicit retry (`fresh: true`) bypasses cache immediately.
      respondWithStack = true
      const retried = await service.stack(STACK_URL, true)
      expect(retried.kind).toBe('stack')
      expect(apiCalls).toHaveBeenCalledTimes(2)
    } finally {
      await service.dispose()
    }
  })

  it('coalesces concurrent reads for the same stack URL', async () => {
    let resolveApi!: (result: ExecResult) => void
    const apiCalls = vi.fn(
      () =>
        new Promise<ExecResult>((resolve) => {
          resolveApi = resolve
        }),
    )
    const service = createGitService({ env: {}, log: () => {} }, { exec: readyToolsExec(apiCalls) })

    try {
      const a = service.stack(STACK_URL)
      const b = service.stack(STACK_URL)
      await new Promise((r) => setTimeout(r, 10))
      resolveApi(
        ok(
          JSON.stringify({
            number: 42,
            open: true,
            base: { ref: 'main' },
            pull_requests: [{ number: 5, state: 'open', head: { ref: 's1' } }],
          }),
        ),
      )
      const [ra, rb] = await Promise.all([a, b])
      expect(ra).toEqual(rb)
      expect(ra.kind).toBe('stack')
      expect(apiCalls).toHaveBeenCalledTimes(1)
    } finally {
      await service.dispose()
    }
  })
})
