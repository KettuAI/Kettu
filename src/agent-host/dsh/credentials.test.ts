// DeepSeek Harness's credential file: the key Kettu hands it, and nothing else of the file touched.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { clearApiKey, readApiKey, readProvider, writeApiKey } from './credentials'

let home: string
const file = () => path.join(home, '.credentials.yaml')

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'kettu-dsh-credentials-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('dsh credentials', () => {
  it('writes the key into a new file only its owner can read', async () => {
    const folder = path.join(home, 'agent')
    await writeApiKey(folder, 'sk-new')
    const written = path.join(folder, '.credentials.yaml')
    expect(parse(await readFile(written, 'utf8'))).toEqual({
      version: 1,
      refs: { DEEPSEEK_API_KEY: 'sk-new' },
    })
    if (process.platform !== 'win32') expect((await stat(written)).mode & 0o777).toBe(0o600)
  })

  it('keeps the other keys, records and comments of the file', async () => {
    await writeFile(
      file(),
      [
        'version: 1',
        '# mine',
        'refs:',
        '  DEEPSEEK_API_KEY: sk-old',
        '  OPENAI_API_KEY: sk-openai',
        'records:',
        '  llm-pi-ai/openai-codex:',
        '    kind: grant',
        '',
      ].join('\n'),
    )
    await writeApiKey(home, 'sk-new')
    const text = await readFile(file(), 'utf8')
    expect(text).toContain('# mine')
    expect(parse(text)).toEqual({
      version: 1,
      refs: { DEEPSEEK_API_KEY: 'sk-new', OPENAI_API_KEY: 'sk-openai' },
      records: { 'llm-pi-ai/openai-codex': { kind: 'grant' } },
    })
    await clearApiKey(home)
    expect(parse(await readFile(file(), 'utf8')).refs).toEqual({ OPENAI_API_KEY: 'sk-openai' })
  })

  it('refuses to rewrite a file it cannot read as YAML', async () => {
    await writeFile(file(), 'refs: [unclosed\n')
    await expect(writeApiKey(home, 'sk-new')).rejects.toThrow(/not valid YAML/)
    expect(await readFile(file(), 'utf8')).toBe('refs: [unclosed\n')
  })

  it('tells the route from what is stored, the account before a key', async () => {
    const env = { DSH_HOME: home }
    expect(await readProvider(env)).toBeNull()
    expect(await readProvider({ ...env, DEEPSEEK_API_KEY: 'sk-env' })).toBe('deepseek-official')
    await writeFile(path.join(home, '.env'), 'DEEPSEEK_API_KEY=sk-dotenv\n')
    expect(await readProvider(env)).toBe('deepseek-official')
    await writeFile(
      file(),
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-x\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n',
    )
    expect(await readProvider(env)).toBe('deepseek-account')
    expect(await readApiKey(env)).toBe('sk-x')
  })
})
