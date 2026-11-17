import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearCodebuddyKey, writeCodebuddyKey } from '../api-key'
import { readCodebuddySite, shellOverrides, writeCodebuddySite } from './user-settings'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-codebuddy-settings-'))
  file = path.join(dir, 'settings.json')
})

afterEach(() => rm(dir, { recursive: true, force: true }))

async function put(value: unknown): Promise<void> {
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
}

async function saved(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8'))
}

describe("a Codebuddy Code agent's site", () => {
  it('reads the site the file names, whatever its case, and none as automatic', async () => {
    expect(await readCodebuddySite(file)).toEqual({ site: 'automatic', otherSite: null })
    await put({ env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'Internal' } })
    expect(await readCodebuddySite(file)).toEqual({ site: 'china', otherSite: null })
    await put({ env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'external' } })
    expect(await readCodebuddySite(file)).toEqual({ site: 'international', otherSite: null })
    await put({ env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'ioa' } })
    expect(await readCodebuddySite(file)).toEqual({ site: 'other', otherSite: 'ioa' })
  })

  it('writes only the site and keeps every other key, in the env too', async () => {
    await put({ theme: 'dark', env: { HTTPS_PROXY: 'http://p:1', CODEBUDDY_API_KEY: 'k' } })
    await writeCodebuddySite(file, { site: 'china' })
    expect(await saved()).toEqual({
      theme: 'dark',
      env: {
        HTTPS_PROXY: 'http://p:1',
        CODEBUDDY_API_KEY: 'k',
        CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
      },
    })
    await writeCodebuddySite(file, { site: 'international' })
    expect((await saved()).env).toMatchObject({ CODEBUDDY_INTERNET_ENVIRONMENT: 'external' })
  })

  it('writes the international site out instead of leaving it unset', async () => {
    await writeCodebuddySite(file, { site: 'international' })
    expect(await saved()).toEqual({ env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'external' } })
  })

  it('removes the key for automatic, and the env once it is empty', async () => {
    await put({ model: 'x', env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' } })
    await writeCodebuddySite(file, { site: 'automatic' })
    expect(await saved()).toEqual({ model: 'x' })
    await put({ env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal', A: 'b' } })
    await writeCodebuddySite(file, { site: 'automatic' })
    expect(await saved()).toEqual({ env: { A: 'b' } })
  })

  it('does not create a file to clear a site that is not there', async () => {
    await writeCodebuddySite(file, { site: 'automatic' })
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a site Settings does not offer and a file it cannot read, writing nothing', async () => {
    await put('{ not json')
    await expect(writeCodebuddySite(file, { site: 'china' })).rejects.toThrow('not valid JSON')
    expect(await readFile(file, 'utf8')).toBe('{ not json')
    await expect(writeCodebuddySite(file, { site: 'ioa' as unknown as 'china' })).rejects.toThrow(
      'The site must be',
    )
  })

  it('names the shell variables that win over the settings, never their values', () => {
    const env: Record<string, string> = {
      CODEBUDDY_AUTH_TOKEN: 'secret',
      WORKBUDDY_CONFIG_DIR: ' ',
    }
    expect(shellOverrides((name) => env[name])).toEqual(['CODEBUDDY_AUTH_TOKEN'])
    expect(shellOverrides(() => undefined)).toEqual([])
  })
})

describe("a Codebuddy Code agent's API key", () => {
  it('writes only its key into env and keeps the rest of the file', async () => {
    await put({
      permissions: { allow: ['x'] },
      env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' },
    })
    await writeCodebuddyKey(file, { key: 'sk-test' })
    expect(await saved()).toEqual({
      permissions: { allow: ['x'] },
      env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal', CODEBUDDY_API_KEY: 'sk-test' },
    })
  })

  it('clears only its key, and the env once nothing else is in it', async () => {
    await put({ env: { CODEBUDDY_API_KEY: 'sk-test', CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' } })
    await clearCodebuddyKey(file)
    expect(await saved()).toEqual({ env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' } })
    await put({ theme: 'dark', env: { CODEBUDDY_API_KEY: 'sk-test' } })
    await clearCodebuddyKey(file)
    expect(await saved()).toEqual({ theme: 'dark' })
  })

  it('leaves a file it cannot read as it is', async () => {
    await put('[1]')
    await expect(writeCodebuddyKey(file, { key: 'sk-test' })).rejects.toThrow('JSON object')
    expect(await readFile(file, 'utf8')).toBe('[1]')
  })
})
