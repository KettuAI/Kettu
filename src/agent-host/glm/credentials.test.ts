// GLM Agent's credentials file (`credentials.json`) and environment resolution.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearGlmKey,
  glmCredentialsFile,
  hasGlmFileKey,
  readGlmSignInState,
  writeGlmKey,
} from './credentials'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'kettu-glm-credentials-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('GLM credentials', () => {
  it('resolves credentials.json under XDG_CONFIG_HOME or ~/.config', () => {
    expect(glmCredentialsFile({}, '/home/alice', 'linux')).toBe(
      '/home/alice/.config/glm-acp-agent/credentials.json',
    )
    expect(glmCredentialsFile({ XDG_CONFIG_HOME: '/custom/cfg' }, '/home/alice', 'darwin')).toBe(
      '/custom/cfg/glm-acp-agent/credentials.json',
    )
    expect(glmCredentialsFile({ XDG_CONFIG_HOME: 'relative/cfg' }, '/home/alice', 'linux')).toBe(
      '/home/alice/relative/cfg/glm-acp-agent/credentials.json',
    )
  })

  it('writes z_ai_api_key with 0600 permissions and preserves other JSON fields', async () => {
    const file = path.join(root, 'glm-acp-agent', 'credentials.json')
    await writeGlmKey(file, 'z-ai-secret-1')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ z_ai_api_key: 'z-ai-secret-1' })
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }

    await writeFile(file, JSON.stringify({ z_ai_api_key: 'old', extra: 'keep' }), 'utf8')
    await writeGlmKey(file, 'z-ai-secret-2')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      z_ai_api_key: 'z-ai-secret-2',
      extra: 'keep',
    })
  })

  it('refuses to overwrite an invalid credentials JSON file', async () => {
    const dir = path.join(root, 'glm-acp-agent')
    const file = path.join(dir, 'credentials.json')
    await mkdir(dir, { recursive: true })
    await writeFile(file, '{ broken json', 'utf8')
    await expect(writeGlmKey(file, 'z-ai-secret')).rejects.toThrow(/not valid JSON/)
    expect(await readFile(file, 'utf8')).toBe('{ broken json')
  })

  it('clears z_ai_api_key and deletes credentials.json when empty, or keeps other fields', async () => {
    const file = path.join(root, 'glm-acp-agent', 'credentials.json')
    await clearGlmKey(file)
    expect(await hasGlmFileKey(file)).toBe(false)

    await writeGlmKey(file, 'z-ai-secret')
    expect(await hasGlmFileKey(file)).toBe(true)
    await clearGlmKey(file)
    expect(await hasGlmFileKey(file)).toBe(false)
    await expect(stat(file)).rejects.toThrow()

    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ z_ai_api_key: 'z-ai-secret', note: 'custom' }), 'utf8')
    await clearGlmKey(file)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ note: 'custom' })
  })

  it('detects signed-out vs signed-in state with Z_AI_API_KEY taking precedence over file', async () => {
    const env = { XDG_CONFIG_HOME: root }
    const platform = process.platform === 'win32' ? 'win32' : process.platform

    expect(await readGlmSignInState({ env, home: root, platform })).toEqual({
      signedIn: false,
      source: null,
      fileKey: false,
    })

    // Blank env var does not count as signed in.
    expect(
      await readGlmSignInState({ env: { ...env, Z_AI_API_KEY: '   ' }, home: root, platform }),
    ).toEqual({
      signedIn: false,
      source: null,
      fileKey: false,
    })

    // Key stored via Kettu env key store.
    expect(await readGlmSignInState({ env, home: root, platform, hasEnvKey: true })).toEqual({
      signedIn: true,
      source: 'env',
      fileKey: false,
    })

    // Key stored on disk via `--setup` or Kettu API key dialog.
    const file = glmCredentialsFile(env, root, platform)
    await writeGlmKey(file, 'sk-file')
    expect(await readGlmSignInState({ env, home: root, platform })).toEqual({
      signedIn: true,
      source: 'file',
      fileKey: true,
    })

    // Z_AI_API_KEY overrides file while still reporting fileKey: true so Clear stays available.
    expect(
      await readGlmSignInState({ env: { ...env, Z_AI_API_KEY: 'sk-env' }, home: root, platform }),
    ).toEqual({
      signedIn: true,
      source: 'env',
      fileKey: true,
    })
  })
})
