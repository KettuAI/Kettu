import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConfigLocation } from './agent-details'
import { claudeJsonPath, readPlanTier, tierOf } from './plan-tier'

describe('tierOf', () => {
  it('reads the multiple at the end of the tier', () => {
    expect(tierOf('default_claude_max_5x')).toBe('5x')
    expect(tierOf('default_claude_max_20x')).toBe('20x')
  })

  it('gives null for a tier without one, and for anything but a string', () => {
    expect(tierOf('default_claude_ai')).toBeNull()
    expect(tierOf('default_claude_max_5x_beta')).toBeNull()
    expect(tierOf('')).toBeNull()
    expect(tierOf(undefined)).toBeNull()
    expect(tierOf(5)).toBeNull()
  })
})

describe('claudeJsonPath', () => {
  const folder = (env: string | null, chosen = false): ConfigLocation => ({
    id: 'folder',
    candidates: ['/srv/claude'],
    env,
    chosen,
  })

  it('is the home directory unless the folder is moved', () => {
    expect(
      claudeJsonPath({ ...folder(null), candidates: ['/home/me/.claude'] }, '/home/me', 'linux'),
    ).toBe('/home/me/.claude.json')
  })

  it('is inside a folder moved by a variable or picked in Settings', () => {
    expect(claudeJsonPath(folder('CLAUDE_CONFIG_DIR'), '/home/me', 'linux')).toBe(
      '/srv/claude/.claude.json',
    )
    expect(claudeJsonPath(folder(null, true), '/home/me', 'darwin')).toBe(
      '/srv/claude/.claude.json',
    )
  })
})

describe('readPlanTier', () => {
  let root: string
  const log = vi.fn()

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'kettu-tier-'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const write = async (name: string, text: string) => {
    const file = path.join(root, name, '.claude.json')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
    return file
  }

  it('reads the tier from the config folder', async () => {
    const file = await write(
      'max',
      JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' } }),
    )
    expect(await readPlanTier(file, log)).toBe('5x')
    expect(log).not.toHaveBeenCalled()
  })

  it('gives null for a missing file without a warning', async () => {
    expect(await readPlanTier(path.join(root, 'missing', '.claude.json'), log)).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  it('gives null for a file without the field', async () => {
    expect(await readPlanTier(await write('none', '{"oauthAccount":{}}'), log)).toBeNull()
    expect(await readPlanTier(await write('array', '[]'), log)).toBeNull()
    expect(
      await readPlanTier(
        await write('pro', '{"oauthAccount":{"organizationRateLimitTier":"default_claude_ai"}}'),
        log,
      ),
    ).toBeNull()
  })

  it('gives null with a warning for a file that does not parse', async () => {
    expect(await readPlanTier(await write('broken', '{"oauthAccount":'), log)).toBeNull()
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('Could not parse'))
  })
})
