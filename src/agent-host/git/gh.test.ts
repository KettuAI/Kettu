import { describe, expect, it } from 'vitest'
import type { Exec, ExecResult } from './exec'
import {
  listBranchPullRequests,
  probeTools,
  viewCurrentPullRequest,
  viewPullRequestByUrl,
} from './gh'

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', failure: null, message: '', ...overrides }
}

/** An exec that answers by the first two arguments and records every call. */
function fakeExec(answers: Record<string, ExecResult>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = []
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args])
    return (
      answers[`${file} ${args.slice(0, 2).join(' ')}`] ??
      answers[`${file} ${args[0]}`] ??
      result({ code: 127 })
    )
  }
  return { exec, calls }
}

const prJson = JSON.stringify({
  number: 7,
  title: 'feat: seven',
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/acme/app/pull/7',
  headRefName: 'feat/seven',
  baseRefName: 'main',
  reviewDecision: '',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
  updatedAt: '2026-10-20T00:00:00Z',
})

describe('viewCurrentPullRequest', () => {
  it('maps the pull request of the branch', async () => {
    const { exec, calls } = fakeExec({ 'gh pr': result({ stdout: prJson }) })
    const outcome = await viewCurrentPullRequest(exec, '/work/app')
    expect(outcome).toMatchObject({ ok: true, value: { number: 7, state: 'open' } })
    expect(calls[0]?.slice(0, 3)).toEqual(['gh', 'pr', 'view'])
  })

  it('gives null when the branch has no pull request', async () => {
    const { exec } = fakeExec({
      'gh pr': result({ code: 1, stderr: 'no pull requests found for branch "x"\n' }),
    })
    expect(await viewCurrentPullRequest(exec, '/work/app')).toEqual({ ok: true, value: null })
  })

  it('fails on other errors, so the caller keeps its last value', async () => {
    const { exec } = fakeExec({
      'gh pr': result({ code: 4, stderr: 'To get started, run: gh auth login' }),
    })
    expect(await viewCurrentPullRequest(exec, '/work/app')).toEqual({
      ok: false,
      reason: 'failed',
      message: 'To get started, run: gh auth login',
    })
  })

  it('reports a missing gh and bad output', async () => {
    const missing = fakeExec({ 'gh pr': result({ code: null, failure: 'not-found' }) })
    expect(await viewCurrentPullRequest(missing.exec, '/w')).toMatchObject({
      ok: false,
      reason: 'not-installed',
    })
    const junk = fakeExec({ 'gh pr': result({ stdout: 'not json' }) })
    expect(await viewCurrentPullRequest(junk.exec, '/w')).toMatchObject({
      ok: false,
      reason: 'failed',
    })
    const wrongHost = fakeExec({
      'gh pr': result({ stdout: prJson.replace('github.com', 'ghe.example.com') }),
    })
    expect(await viewCurrentPullRequest(wrongHost.exec, '/w')).toMatchObject({ ok: false })
  })
})

describe('listBranchPullRequests', () => {
  it('maps branches to pull requests', async () => {
    const list = JSON.stringify([
      {
        number: 7,
        state: 'OPEN',
        isDraft: false,
        url: 'https://github.com/acme/app/pull/7',
        headRefName: 'feat/seven',
      },
    ])
    const { exec, calls } = fakeExec({ 'gh pr': result({ stdout: list }) })
    const outcome = await listBranchPullRequests(exec, '/work/app')
    expect(outcome.ok && outcome.value.get('feat/seven')).toEqual({
      number: 7,
      state: 'open',
      url: 'https://github.com/acme/app/pull/7',
    })
    expect(calls[0]).toContain('--state')
    expect(calls[0]).toContain('all')
  })

  it('fails on a non-zero exit', async () => {
    const { exec } = fakeExec({ 'gh pr': result({ code: 1, stderr: 'boom' }) })
    expect(await listBranchPullRequests(exec, '/w')).toMatchObject({ ok: false, message: 'boom' })
  })
})

describe('viewPullRequestByUrl', () => {
  it('passes the URL to gh pr view', async () => {
    const { exec, calls } = fakeExec({ 'gh pr': result({ stdout: prJson }) })
    const outcome = await viewPullRequestByUrl(exec, 'https://github.com/acme/app/pull/7', '/home')
    expect(outcome.ok).toBe(true)
    expect(calls[0]?.slice(0, 4)).toEqual([
      'gh',
      'pr',
      'view',
      'https://github.com/acme/app/pull/7',
    ])
  })
})

describe('probeTools', () => {
  const git = result({ stdout: 'git version 2.51.2\n' })
  const ghVersion = result({ stdout: 'gh version 2.98.0 (2026-08-20)\n' })

  it('is ready when gh is signed in', async () => {
    const { exec, calls } = fakeExec({
      'git --version': git,
      'gh --version': ghVersion,
      'gh auth': result({
        stdout:
          'github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n',
      }),
    })
    expect(await probeTools(exec, '/home')).toEqual({
      git: { found: true, version: '2.51.2' },
      gh: { state: 'ready', version: '2.98.0', account: 'octocat' },
    })
    expect(calls).toContainEqual(['gh', 'auth', 'status', '--hostname', 'github.com'])
  })

  it('reads the account from stderr for older gh', async () => {
    const { exec } = fakeExec({
      'git --version': git,
      'gh --version': ghVersion,
      'gh auth': result({
        stderr: 'github.com\n  ✓ Logged in to github.com as octocat (oauth_token)\n',
      }),
    })
    expect((await probeTools(exec, '/home')).gh.account).toBe('octocat')
  })

  it('is signed out on a non-zero exit', async () => {
    const { exec } = fakeExec({
      'git --version': git,
      'gh --version': ghVersion,
      'gh auth': result({ code: 1, stdout: 'You are not logged into any GitHub hosts.' }),
    })
    expect((await probeTools(exec, '/home')).gh).toEqual({
      state: 'signed-out',
      version: '2.98.0',
      account: null,
    })
  })

  it('is not installed when gh is missing, and does not ask it to authenticate', async () => {
    const { exec, calls } = fakeExec({
      'git --version': git,
      'gh --version': result({ code: null, failure: 'not-found' }),
    })
    expect((await probeTools(exec, '/home')).gh).toEqual({
      state: 'not-installed',
      version: null,
      account: null,
    })
    expect(calls.some((call) => call[1] === 'auth')).toBe(false)
  })

  it('reports a missing git', async () => {
    const { exec } = fakeExec({
      'git --version': result({ code: null, failure: 'not-found' }),
      'gh --version': ghVersion,
      'gh auth': result({ code: 1 }),
    })
    expect((await probeTools(exec, '/home')).git).toEqual({ found: false, version: null })
  })
})
