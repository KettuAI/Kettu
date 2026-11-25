import { afterEach, describe, expect, it, vi } from 'vitest'
import { DRIVE_WAIT_MS, listDrives } from './path-completion'

const folder = { isDirectory: () => true }
const file = { isDirectory: () => false }

function notFound(): Error {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
}

/** A stat that knows only the given roots and records what it was asked for. */
function fakeStat(roots: Record<string, () => Promise<{ isDirectory(): boolean }>>) {
  const asked: string[] = []
  const stat = (path: string): Promise<{ isDirectory(): boolean }> => {
    asked.push(path)
    return roots[path]?.() ?? Promise.reject(notFound())
  }
  return { stat, asked }
}

describe('listDrives', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists the drives of a Windows host by their roots, in letter order', async () => {
    const { stat, asked } = fakeStat({
      'D:\\': () => Promise.resolve(folder),
      'C:\\': () => Promise.resolve(folder),
    })
    await expect(listDrives('win32', stat)).resolves.toEqual(['C:\\', 'D:\\'])
    expect(asked).toHaveLength(26)
    expect(asked[0]).toBe('A:\\')
    expect(asked.at(-1)).toBe('Z:\\')
  })

  it('leaves out a drive that is not ready or is not a folder', async () => {
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    const { stat } = fakeStat({
      'C:\\': () => Promise.resolve(folder),
      'E:\\': () => Promise.reject(busy),
      'F:\\': () => Promise.resolve(file),
    })
    await expect(listDrives('win32', stat)).resolves.toEqual(['C:\\'])
  })

  it('leaves out a drive that does not answer in time', async () => {
    vi.useFakeTimers()
    const { stat } = fakeStat({
      'C:\\': () => Promise.resolve(folder),
      'Z:\\': () => new Promise(() => {}),
    })
    const listed = listDrives('win32', stat)
    await vi.advanceTimersByTimeAsync(DRIVE_WAIT_MS)
    await expect(listed).resolves.toEqual(['C:\\'])
  })

  it('lists none on other systems, without reading anything', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { stat, asked } = fakeStat({ '/': () => Promise.resolve(folder) })
      await expect(listDrives(platform, stat)).resolves.toEqual([])
      expect(asked).toEqual([])
    }
  })
})
