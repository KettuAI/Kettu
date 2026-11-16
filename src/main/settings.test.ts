import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { splitSettingsPatch } from '@shared/remote/host-admin'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { SettingsStore } from './settings'
import { hostSettings, mergeSettings, validateSettingsPatch } from './settings-schema'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-settings-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const save = (value: unknown): Promise<void> =>
  writeFile(join(dir, 'settings.json'), typeof value === 'string' ? value : JSON.stringify(value))

describe('the first start record on load', () => {
  it('leaves a host without a settings file to run its first start', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().initialSetup).toEqual({ done: false })
  })

  it('counts a file from before the record as a host set up by hand', async () => {
    await save({ version: 1, general: { language: 'en' } })
    const store = await SettingsStore.load(dir)
    expect(store.get().initialSetup).toEqual({ done: true })
  })

  it('counts an unreadable file the same, since it has history', async () => {
    await save('{ not json')
    const store = await SettingsStore.load(dir)
    expect(store.get().initialSetup.done).toBe(true)
  })

  it('keeps a record that says the first start has not run', async () => {
    await save({ version: 1, initialSetup: { done: false } })
    const store = await SettingsStore.load(dir)
    expect(store.get().initialSetup.done).toBe(false)
  })
})

describe('the onboarding and the cloud switch on load', () => {
  it('starts the onboarding on a fresh install, with the cloud on until a choice', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().onboarding).toEqual({ done: false, step: 'welcome' })
    expect(store.get().cloud).toEqual({ enabled: true })
  })

  it('skips the onboarding for a file from before it, keeping the cloud on', async () => {
    await save({ version: 1, initialSetup: { done: true }, general: { language: 'en' } })
    const store = await SettingsStore.load(dir)
    expect(store.get().onboarding.done).toBe(true)
    expect(store.get().cloud.enabled).toBe(true)
  })

  it('skips it for an unreadable file too, since it has history', async () => {
    await save('{ not json')
    const store = await SettingsStore.load(dir)
    expect(store.get().onboarding.done).toBe(true)
  })

  it('resumes an unfinished onboarding at its step and keeps a self-hosted choice', async () => {
    await save({
      version: 1,
      initialSetup: { done: true },
      onboarding: { done: false, step: 'agents' },
      cloud: { enabled: false },
    })
    const store = await SettingsStore.load(dir)
    expect(store.get().onboarding).toEqual({ done: false, step: 'agents' })
    expect(store.get().cloud.enabled).toBe(false)
  })

  it('falls back to the defaults for values it does not know', async () => {
    await save({ version: 1, onboarding: { done: 'no', step: 'nowhere' }, cloud: { enabled: 0 } })
    const store = await SettingsStore.load(dir)
    expect(store.get().onboarding).toEqual({ done: false, step: 'welcome' })
    expect(store.get().cloud.enabled).toBe(true)
  })
})

describe('adding the agents the first start found', () => {
  it('adds the default agents in the list order and records them once', async () => {
    const store = await SettingsStore.load(dir)
    const next = store.firstStart(['codex', 'not-a-harness', 'claude-code', 'codex'])
    expect(next.initialSetup).toEqual({ done: true })
    expect(next.agents['claude-code']).toEqual({ enabled: true })
    expect(next.agents.codex).toEqual({ enabled: true })
    expect(store.firstStart(['opencode']).agents.opencode).toBeUndefined()
    await store.flush()
  })

  it('makes the first agent added the default when none is chosen', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.firstStart(['codex', 'claude-code']).general.defaultAgent).toBe('claude-code')
    await store.flush()
  })

  it('keeps a default agent that was chosen', async () => {
    await save({
      version: 1,
      initialSetup: { done: false },
      general: { defaultAgent: 'pi' },
    })
    const store = await SettingsStore.load(dir)
    expect(store.firstStart(['claude-code']).general.defaultAgent).toBe('pi')
    await store.flush()
  })

  it('is done even when it found nothing', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.firstStart([]).initialSetup).toEqual({ done: true })
    await store.flush()
  })

  it('adds only harnesses that run the user program', async () => {
    const store = await SettingsStore.load(dir)
    const next = store.firstStart(['gemini', 'opencode'])
    expect(next.agents.gemini).toBeUndefined()
    expect(next.agents.opencode).toEqual({ enabled: true })
    await store.flush()
  })

  it('leaves a harness the user removed before as it is', async () => {
    await save({
      version: 1,
      initialSetup: { done: false },
      agents: { codex: { enabled: false } },
    })
    const store = await SettingsStore.load(dir)
    const next = store.firstStart(['claude-code', 'codex'])
    expect(next.agents['claude-code']).toEqual({ enabled: true })
    expect(next.agents.codex).toEqual({ enabled: false })
    await store.flush()
  })
})

describe('where worktrees go', () => {
  it('puts them beside each project until a folder is chosen', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().git.worktreeRoot).toBeNull()
  })

  it('keeps an absolute folder and drops anything else on load', async () => {
    const root = join(dir, 'worktrees')
    await save({ version: 1, git: { backgroundFetch: true, worktreeRoot: root } })
    expect((await SettingsStore.load(dir)).get().git).toEqual({
      backgroundFetch: true,
      worktreeRoot: root,
    })
    for (const bad of ['relative/worktrees', '', 7, `${root}\0x`]) {
      await save({ version: 1, git: { worktreeRoot: bad } })
      expect((await SettingsStore.load(dir)).get().git.worktreeRoot).toBeNull()
    }
  })

  it('takes an absolute folder or null in a change and refuses the rest', () => {
    const root = join(dir, 'worktrees')
    expect(validateSettingsPatch({ git: { worktreeRoot: root } })).toEqual({
      git: { worktreeRoot: root },
    })
    expect(validateSettingsPatch({ git: { worktreeRoot: null } })).toEqual({
      git: { worktreeRoot: null },
    })
    for (const bad of ['relative', '', 3, `${root}\0x`]) {
      expect(() => validateSettingsPatch({ git: { worktreeRoot: bad } })).toThrow()
    }
  })
})

describe('when idle sessions let their agent go', () => {
  it('releases by memory until the user picks, with Custom at 5 and 30 minutes and no limit', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().idleSessions).toEqual({
      release: 'auto',
      outOfView: 5,
      inView: 30,
      limit: null,
    })
    expect(hostSettings(store.get(), 'en').idleSessions).toEqual(store.get().idleSessions)
  })

  it('takes only the listed modes, minutes and limits in a change', () => {
    for (const release of ['auto', 'custom', 'never']) {
      expect(validateSettingsPatch({ idleSessions: { release } })).toEqual({
        idleSessions: { release },
      })
    }
    for (const outOfView of [1, 5, 15, 30, 60]) {
      expect(() => validateSettingsPatch({ idleSessions: { outOfView } })).not.toThrow()
    }
    for (const inView of [5, 15, 30, 60]) {
      expect(() => validateSettingsPatch({ idleSessions: { inView } })).not.toThrow()
    }
    for (const limit of [null, 1, 2, 3, 5]) {
      expect(() => validateSettingsPatch({ idleSessions: { limit } })).not.toThrow()
    }
    for (const bad of [
      { release: 'always' },
      { release: null },
      { outOfView: 0 },
      { outOfView: 2 },
      { outOfView: '5' },
      { outOfView: 120 },
      { inView: 1 },
      { inView: 45 },
      { limit: 0 },
      { limit: 4 },
      { limit: 'none' },
      { limit: 1.5 },
      { other: true },
    ]) {
      expect(() => validateSettingsPatch({ idleSessions: bad })).toThrow()
    }
    expect(() => validateSettingsPatch({ idleSessions: 'never' })).toThrow()
  })

  it('merges a change key by key and keeps it the host’s', () => {
    const before = structuredClone(DEFAULT_SETTINGS)
    const patch = validateSettingsPatch({ idleSessions: { release: 'custom', limit: 2 } })
    expect(mergeSettings(before, patch).idleSessions).toEqual({
      release: 'custom',
      outOfView: 5,
      inView: 30,
      limit: 2,
    })
    expect(splitSettingsPatch(patch)).toEqual({ host: patch, client: null })
  })

  it('keeps the valid values of a stored section and drops the rest', async () => {
    await save({
      version: 1,
      idleSessions: { release: 'custom', outOfView: 60, inView: 7, limit: 3, extra: 1 },
    })
    expect((await SettingsStore.load(dir)).get().idleSessions).toEqual({
      release: 'custom',
      outOfView: 60,
      inView: 30,
      limit: 3,
    })
    await save({ version: 1, idleSessions: 'never' })
    expect((await SettingsStore.load(dir)).get().idleSessions.release).toBe('auto')
  })
})

describe('items from the Kettu Marketplace in a patch', () => {
  const skill = {
    id: 'kettu:abcdefgh23',
    name: 'greeter',
    description: 'Greets the user.',
    source: 'kettu',
    origin: '@amigoer/greeter',
    version: '1.0.0',
    agents: 'all',
    on: true,
  }
  const server = {
    id: 'kettu:abcdefgh23',
    name: 'memory-notes',
    title: 'Memory Notes',
    source: 'kettu',
    version: '2.1.1',
    spec: { type: 'stdio', command: 'npx', args: ['-y', 'pkg@2.1.1'], env: [] },
    agents: 'all',
    on: true,
  }

  it('keeps a skill and a server by their listing', () => {
    expect(validateSettingsPatch({ marketplace: { skills: [skill] } })).toEqual({
      marketplace: { skills: [skill] },
    })
    expect(validateSettingsPatch({ marketplace: { mcp: [server] } })).toEqual({
      marketplace: { mcp: [server] },
    })
  })

  it('keeps a bundle’s server on Kettu’s Node.js with its inputs’ labels and kinds', () => {
    const bundled = {
      ...server,
      spec: {
        type: 'stdio',
        command: 'node',
        args: ['/data/marketplace/mcpb/abcdefgh23/1.0.0/server/index.js'],
        env: [
          {
            name: 'ECHO_KEY',
            input: true,
            secret: false,
            required: true,
            title: 'Port',
            kind: 'number',
            default: '8080',
            min: 1,
            max: 65535,
          },
        ],
        runtime: 'node',
      },
    }
    expect(validateSettingsPatch({ marketplace: { mcp: [bundled] } })).toEqual({
      marketplace: { mcp: [bundled] },
    })
    const env = (over: Record<string, unknown>) => ({
      ...bundled,
      spec: { ...bundled.spec, env: [{ ...bundled.spec.env[0], ...over }] },
    })
    for (const bad of [
      { ...bundled, spec: { ...bundled.spec, runtime: '/Applications/Kettu.app' } },
      env({ kind: 'color' }),
      env({ min: 'one' }),
      env({ title: 'a\nb' }),
      env({ default: 1 }),
    ]) {
      expect(() => validateSettingsPatch({ marketplace: { mcp: [bad] } })).toThrow()
    }
  })

  it('keeps a catalog skill from any repository by owner/repo and name', () => {
    const catalog = {
      ...skill,
      id: 'trailofbits/skills:semgrep',
      name: 'semgrep',
      source: 'catalog',
      origin: 'https://github.com/trailofbits/skills',
    }
    expect(validateSettingsPatch({ marketplace: { skills: [catalog] } })).toEqual({
      marketplace: { skills: [catalog] },
    })
    for (const id of ['semgrep', '../skills:semgrep', 'trailofbits/skills:Semgrep']) {
      expect(() =>
        validateSettingsPatch({ marketplace: { skills: [{ ...catalog, id }] } }),
      ).toThrow()
    }
  })

  it('refuses an id or origin that names no listing', () => {
    for (const bad of [
      { ...skill, id: 'kettu:../x' },
      { ...skill, id: 'local:abcdefgh23' },
      { ...skill, origin: 'https://example.com/greeter' },
      { ...skill, origin: '@amigoer/../x' },
    ]) {
      expect(() => validateSettingsPatch({ marketplace: { skills: [bad] } })).toThrow()
    }
    expect(() =>
      validateSettingsPatch({ marketplace: { mcp: [{ ...server, id: 'kettu:ABC' }] } }),
    ).toThrow()
  })
})
