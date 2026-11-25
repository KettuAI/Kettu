import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearFlagSettings, removeFlagSettings, writeFlagSettings } from './flag-settings'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kettu-flag-settings-'))
  dirs.push(dir)
  return path.join(dir, 'claude-settings')
}

describe("Claude Code's flag settings files", () => {
  it('writes each to a file of its own that only the user can read', async () => {
    const dir = await folder()
    // A folder someone else could list is narrowed before anything goes in it.
    await mkdir(dir, { mode: 0o755 })
    const settings = { env: { ANTHROPIC_AUTH_TOKEN: 'fake-token-1234' } }
    const first = await writeFlagSettings(dir, settings)
    const second = await writeFlagSettings(dir, { disableAllHooks: true })
    expect(first).not.toBe(second)
    expect(path.dirname(first)).toBe(dir)
    expect(JSON.parse(await readFile(first, 'utf8'))).toEqual(settings)
    if (process.platform !== 'win32') {
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      expect((await stat(first)).mode & 0o777).toBe(0o600)
    }
    await removeFlagSettings(first)
    expect(await readdir(dir)).toEqual([path.basename(second)])
  })

  it('clears what an earlier run left', async () => {
    const dir = await folder()
    await writeFlagSettings(dir, { disableAllHooks: true })
    await clearFlagSettings(dir)
    await expect(stat(dir)).rejects.toThrow()
    // Nothing there to clear is no error.
    await clearFlagSettings(dir)
  })
})
