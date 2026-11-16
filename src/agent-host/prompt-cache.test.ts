import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeCacheTtl, claudeProjectFolder } from './prompt-cache'

const SESSION = '1d61fb20-3e0a-46cb-9d74-8ff5ec57682a'
const HOUR = 60 * 60_000

const wrote = (split: Record<string, number>): string =>
  JSON.stringify({
    type: 'assistant',
    message: { usage: { cache_creation: split } },
  })

describe('claudeCacheTtl', () => {
  let home: string
  let cwd: string

  beforeEach(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-cache-')))
    cwd = path.join(home, 'project')
    await mkdir(cwd)
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function transcript(configDir: string, line: string): Promise<void> {
    const folder = path.join(configDir, 'projects', claudeProjectFolder(cwd))
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, `${SESSION}.jsonl`), `${line}\n`)
  }

  function reader() {
    return claudeCacheTtl({
      platform: process.platform,
      home,
      env: async () => ({}),
      log: () => {},
    })
  }

  it('reads an added agent from its own configuration folder', async () => {
    const configDir = path.join(home, '.kettu', 'agents', 'claude-code~company')
    await transcript(
      configDir,
      wrote({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 472 }),
    )
    // A transcript of the same id in the default folder must not be the one read.
    await transcript(path.join(home, '.claude'), wrote({ ephemeral_5m_input_tokens: 10 }))

    await expect(reader()('claude-code~company', cwd, SESSION, configDir)).resolves.toBe(HOUR)
  })

  it('reads the default agent from the default folder', async () => {
    await transcript(path.join(home, '.claude'), wrote({ ephemeral_1h_input_tokens: 9 }))

    await expect(reader()('claude-code', cwd, SESSION, null)).resolves.toBe(HOUR)
  })

  it('reads nothing for another harness', async () => {
    await transcript(path.join(home, '.claude'), wrote({ ephemeral_1h_input_tokens: 9 }))

    await expect(reader()('codex', cwd, SESSION, null)).resolves.toBeNull()
  })
})
