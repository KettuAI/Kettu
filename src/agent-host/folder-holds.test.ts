import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { geminiFolderHold, qwenFolderHold } from './folder-holds'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-folder-holds-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const platform = process.platform === 'win32' ? 'win32' : 'darwin'

describe("the system settings that hold a folder's own config back", () => {
  it("turn Qwen's folder trust on over the machine's own, trusting no folder", async () => {
    const machine = path.join(dir, 'machine.json')
    await writeFile(machine, '{ "model": { "name": "q" }, "security": { "auth": "x" } }')
    const env = await qwenFolderHold(
      path.join(dir, 'kettu'),
      { QWEN_CODE_SYSTEM_SETTINGS_PATH: machine },
      platform,
    )
    const settings = JSON.parse(await readFile(env.QWEN_CODE_SYSTEM_SETTINGS_PATH!, 'utf8'))
    expect(settings).toEqual({
      model: { name: 'q' },
      security: { auth: 'x', folderTrust: { enabled: true } },
    })
    expect(JSON.parse(await readFile(env.QWEN_CODE_TRUSTED_FOLDERS_PATH!, 'utf8'))).toEqual({})
    // The machine's own file stays as it was.
    expect(await readFile(machine, 'utf8')).toContain('"auth": "x" }')
    if (platform !== 'win32') {
      expect((await stat(env.QWEN_CODE_SYSTEM_SETTINGS_PATH!)).mode & 0o777).toBe(0o600)
    }
  })

  it("keep Gemini CLI from a folder's .env, with no system settings of the machine's", async () => {
    await mkdir(path.join(dir, 'kettu'))
    const env = await geminiFolderHold(
      path.join(dir, 'kettu'),
      { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(dir, 'missing.json') },
      platform,
    )
    expect(JSON.parse(await readFile(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, 'utf8'))).toEqual({
      advanced: { ignoreLocalEnv: true },
    })
  })
})
