import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkApiKey, clearClaudeKey, writeClaudeKey } from './api-key'
import { tempFolder } from './testing/temp'

async function settingsFile(content?: unknown): Promise<string> {
  const file = path.join(await tempFolder('kettu-api-key-'), 'config', 'settings.json')
  if (content !== undefined) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return file
}

const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'))

describe('checkApiKey', () => {
  it('trims what was typed and keeps only what is set', () => {
    expect(checkApiKey({ key: ' sk-1 ', baseUrl: ' ', model: '' }, true)).toEqual({ key: 'sk-1' })
    expect(
      checkApiKey({ key: 'k', baseUrl: 'https://api.example.com/v1', model: 'glm-4.6' }, true),
    ).toEqual({ key: 'k', baseUrl: 'https://api.example.com/v1', model: 'glm-4.6' })
  })

  it('refuses a key with spaces, an address that is not http, and a provider for Codex', () => {
    expect(() => checkApiKey({ key: '' }, true)).toThrow('one word')
    expect(() => checkApiKey({ key: 'a b' }, true)).toThrow('one word')
    expect(() => checkApiKey({ key: 'k', baseUrl: 'file:///etc' }, true)).toThrow('http')
    expect(() => checkApiKey({ key: 'k', baseUrl: 'not a url' }, true)).toThrow('http')
    expect(() => checkApiKey({ key: 'k', model: 'a b' }, true)).toThrow('model')
    expect(() => checkApiKey({ key: 'k', baseUrl: 'https://x.test' }, false)).toThrow(
      'only an API key',
    )
  })
})

describe("Claude Code's key in its settings.json", () => {
  it("writes Anthropic's key, making the folder and the file", async () => {
    const file = await settingsFile()
    await writeClaudeKey(file, { key: 'sk-ant' })
    expect(await read(file)).toEqual({ env: { ANTHROPIC_API_KEY: 'sk-ant' } })
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it("sends another provider's key as a token to its address, with its model", async () => {
    const file = await settingsFile()
    await writeClaudeKey(file, { key: 'sk-ant' })
    await writeClaudeKey(file, {
      key: 'zk',
      baseUrl: 'https://open.example.com/api/anthropic',
      model: 'glm-4.6',
    })
    expect(await read(file)).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://open.example.com/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'zk',
        ANTHROPIC_MODEL: 'glm-4.6',
      },
    })
  })

  it('keeps everything else the user wrote', async () => {
    const file = await settingsFile({ model: 'opus', env: { DISABLE_TELEMETRY: '1' } })
    await writeClaudeKey(file, { key: 'sk-ant' })
    expect(await read(file)).toEqual({
      model: 'opus',
      env: { DISABLE_TELEMETRY: '1', ANTHROPIC_API_KEY: 'sk-ant' },
    })
    await clearClaudeKey(file)
    expect(await read(file)).toEqual({ model: 'opus', env: { DISABLE_TELEMETRY: '1' } })
  })

  it('removes env once only the key was in it, and leaves a file without a key alone', async () => {
    const file = await settingsFile({ theme: 'dark' })
    await writeClaudeKey(file, { key: 'sk-ant' })
    await clearClaudeKey(file)
    expect(await read(file)).toEqual({ theme: 'dark' })
    const text = '{ "theme": "dark" }'
    await writeFile(file, text)
    await clearClaudeKey(file)
    expect(await readFile(file, 'utf8')).toBe(text)
    await clearClaudeKey(path.join(path.dirname(file), 'missing.json'))
  })

  it('refuses to rewrite a file it cannot read', async () => {
    const file = await settingsFile('{ "theme": ')
    await expect(writeClaudeKey(file, { key: 'k' })).rejects.toThrow('not valid JSON')
    expect(await readFile(file, 'utf8')).toBe('{ "theme": ')
    await writeFile(file, '[]')
    await expect(writeClaudeKey(file, { key: 'k' })).rejects.toThrow('JSON object')
  })
})
