import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureName, saveCapture } from './device-captures'

let folder: string

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'kettu-captures-'))
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

describe('device captures', () => {
  it('names a capture after its device, never as a path', () => {
    const at = new Date(2026, 10, 14, 9, 5, 7)
    expect(captureName('iPhone 17 Pro', 'png', at)).toBe('iPhone 17 Pro 2026-11-14 at 09.05.07.png')
    expect(captureName('../../etc/passwd', 'mp4', at)).toBe(
      '-..-etc-passwd 2026-11-14 at 09.05.07.mp4',
    )
    expect(captureName('', 'webm', at)).toBe('Device 2026-11-14 at 09.05.07.webm')
  })

  it('refuses another kind of file, a missing name and what is not bytes', async () => {
    const at = new Date()
    expect(() => captureName('Phone', 'sh', at)).toThrow()
    expect(() => captureName('Phone', '../png', at)).toThrow()
    expect(() => captureName(7, 'png', at)).toThrow()
    await expect(saveCapture(folder, 'Phone', 'png', 'text')).rejects.toThrow()
    await expect(saveCapture(folder, 'Phone', 'png', new ArrayBuffer(0))).rejects.toThrow()
    expect(await readdir(folder)).toEqual([])
  })

  it('writes into the folder and never over a file that is there', async () => {
    const first = await saveCapture(folder, 'a/b', 'png', new Uint8Array([1]).buffer)
    const second = await saveCapture(folder, 'a/b', 'png', new Uint8Array([2]))
    expect(path.dirname(first)).toBe(folder)
    expect(path.dirname(second)).toBe(folder)
    expect(second).not.toBe(first)
    expect([...(await readFile(first))]).toEqual([1])
    expect([...(await readFile(second))]).toEqual([2])
  })
})
