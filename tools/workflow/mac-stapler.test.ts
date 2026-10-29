import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateTicket } from './mac-stapler.mjs'

const appPath = '/Volumes/Over Bench/Kettu.app'
const failure = (code: number | string) => Object.assign(new Error('stapler failed'), { code })

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('validateTicket', () => {
  it('passes a path with spaces to stapler and finishes without waiting on success', async () => {
    const run = vi.fn<(appPath: string) => Promise<void>>().mockResolvedValue()
    const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue()
    await validateTicket(appPath, { run, wait })
    expect(run).toHaveBeenCalledExactlyOnceWith(appPath)
    expect(wait).not.toHaveBeenCalled()
  })

  it('recovers from ticket lookup failures with bounded backoff', async () => {
    const run = vi
      .fn<(appPath: string) => Promise<void>>()
      .mockRejectedValueOnce(failure(68))
      .mockRejectedValueOnce(failure(68))
      .mockResolvedValue()
    const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue()
    await validateTicket(appPath, { run, wait })
    expect(run).toHaveBeenCalledTimes(3)
    expect(wait.mock.calls).toEqual([[10_000], [20_000]])
  })

  it('fails with the final error when the ticket service never recovers', async () => {
    const last = failure(68)
    const run = vi
      .fn<(appPath: string) => Promise<void>>()
      .mockRejectedValueOnce(failure(68))
      .mockRejectedValueOnce(failure(68))
      .mockRejectedValueOnce(last)
    const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue()
    await expect(validateTicket(appPath, { run, wait })).rejects.toBe(last)
    expect(run).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it.each([65, 'ENOENT', 'ETIMEDOUT'])(
    'fails immediately for a permanent or unrelated error (%s)',
    async (code) => {
      const error = failure(code)
      const run = vi.fn<(appPath: string) => Promise<void>>().mockRejectedValue(error)
      const wait = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue()
      await expect(validateTicket(appPath, { run, wait })).rejects.toBe(error)
      expect(run).toHaveBeenCalledTimes(1)
      expect(wait).not.toHaveBeenCalled()
    },
  )
})
