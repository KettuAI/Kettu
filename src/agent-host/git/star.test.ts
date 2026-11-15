import { describe, expect, it } from 'vitest'
import type { Exec, ExecResult } from './exec'
import { checkStarred, STAR_ARGS, STAR_CHECK_ARGS, starRepository } from './star'

function fakeExec(result: Partial<ExecResult>): { exec: Exec; calls: [string, string[]][] } {
  const calls: [string, string[]][] = []
  const exec: Exec = (file, args) => {
    calls.push([file, [...args]])
    return Promise.resolve({
      code: 0,
      stdout: '',
      stderr: '',
      failure: null,
      message: '',
      ...result,
    })
  }
  return { exec, calls }
}

describe('GitHub star through gh', () => {
  it('only ever runs the two fixed commands on Kettu’s own repository', async () => {
    const { exec, calls } = fakeExec({})
    await checkStarred(exec, '/home')
    await starRepository(exec, '/home')
    expect(calls).toEqual([
      ['gh', ['api', 'user/starred/KettuAI/Kettu']],
      ['gh', ['api', '--method', 'PUT', 'user/starred/KettuAI/Kettu']],
    ])
    expect(STAR_CHECK_ARGS).toEqual(['api', 'user/starred/KettuAI/Kettu'])
    expect(STAR_ARGS).toEqual(['api', '--method', 'PUT', 'user/starred/KettuAI/Kettu'])
  })

  it('reads 204 as starred, 404 as not starred and anything else as gh being unavailable', async () => {
    expect(await checkStarred(fakeExec({ code: 0 }).exec, '/')).toBe('starred')
    const notFound = fakeExec({ code: 1, stderr: 'gh: Not Found (HTTP 404)' })
    expect(await checkStarred(notFound.exec, '/')).toBe('not-starred')
    const badToken = fakeExec({ code: 1, stderr: 'gh: Bad credentials (HTTP 401)' })
    expect(await checkStarred(badToken.exec, '/')).toBe('unavailable')
    expect(await checkStarred(fakeExec({ code: 4, stderr: 'gh auth login' }).exec, '/')).toBe(
      'unavailable',
    )
    const missing = fakeExec({ code: null, failure: 'not-found' })
    expect(await checkStarred(missing.exec, '/')).toBe('unavailable')
  })

  it('reports a star only when gh succeeded', async () => {
    expect(await starRepository(fakeExec({ code: 0 }).exec, '/')).toBe(true)
    expect(await starRepository(fakeExec({ code: 1 }).exec, '/')).toBe(false)
    expect(await starRepository(fakeExec({ code: null, failure: 'timeout' }).exec, '/')).toBe(false)
  })
})
