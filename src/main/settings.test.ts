import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hostSettingsPart, splitSettingsPatch, withHostSettings } from '@shared/remote/host-admin'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { SettingsStore } from './settings'
import {
  effectiveDirect,
  hostSettings,
  mergeSettings,
  validateSettingsPatch,
  withOwnRelay,
} from './settings-schema'

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

  it('adds every harness whose own program was found, npm packages included', async () => {
    const store = await SettingsStore.load(dir)
    const next = store.firstStart(['deepseek', 'gemini', 'opencode'])
    expect(next.agents.deepseek).toEqual({ enabled: true })
    expect(next.agents.gemini).toEqual({ enabled: true })
    expect(next.agents.opencode).toEqual({ enabled: true })
    expect(next.general.defaultAgent).toBe('opencode')
    await store.flush()
  })

  it('never adds the development agent, which needs no adding', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.firstStart(['fake-agent']).agents['fake-agent']).toBeUndefined()
    await store.flush()
  })

  it('adds Antigravity, which runs the user agy, after the others', async () => {
    const store = await SettingsStore.load(dir)
    const next = store.firstStart(['antigravity', 'codex'])
    expect(next.agents.antigravity).toEqual({ enabled: true })
    expect(next.general.defaultAgent).toBe('codex')
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

describe('the mode new sessions start in', () => {
  const modes = {
    'claude-code': 'bypassPermissions',
    codex: 'agent-full-access',
    deepseek: 'danger-full-access',
    antigravity: 'dangerously-skip-permissions',
  }

  it('keeps any mode the user chose on load, full access included', async () => {
    await save({ version: 1, startModes: { ...modes, opencode: 'build' } })
    expect((await SettingsStore.load(dir)).get().startModes).toEqual(modes)
  })

  it('takes full access in a change, and refuses an agent that takes no mode', () => {
    expect(validateSettingsPatch({ startModes: modes })).toEqual({ startModes: modes })
    expect(validateSettingsPatch({ startModes: { codex: null } })).toEqual({
      startModes: { codex: null },
    })
    for (const bad of [{ opencode: 'build' }, { codex: '' }, { codex: 7 }]) {
      expect(() => validateSettingsPatch({ startModes: bad })).toThrow()
    }
  })
})

describe('the model of lightweight tasks', () => {
  const pinned = { mode: 'pinned', agentId: 'codex', model: 'gpt-5.5-mini' }

  it('picks a small model until another is chosen, and keeps a valid choice on load', async () => {
    expect((await SettingsStore.load(dir)).get().general.lightModel).toEqual({ mode: 'small' })
    for (const choice of [{ mode: 'session' }, pinned]) {
      await save({ version: 1, general: { lightModel: choice } })
      expect((await SettingsStore.load(dir)).get().general.lightModel).toEqual(choice)
    }
  })

  const bad = [
    'small',
    { mode: 'other' },
    { mode: 'small', agentId: 'codex' },
    { mode: 'pinned', agentId: 'codex' },
    { mode: 'pinned', agentId: 'not an agent', model: 'm' },
    { mode: 'pinned', agentId: 'codex', model: ' ' },
    { mode: 'pinned', agentId: 'codex', model: 'm\0' },
    { mode: 'pinned', agentId: 'codex', model: 'm'.repeat(201) },
    { ...pinned, extra: true },
  ]

  it('drops anything else on load', async () => {
    for (const choice of bad) {
      await save({ version: 1, general: { lightModel: choice } })
      expect((await SettingsStore.load(dir)).get().general.lightModel).toEqual({ mode: 'small' })
    }
  })

  it('takes one of the three in a change, replaced whole, and refuses the rest', () => {
    const patch = validateSettingsPatch({ general: { lightModel: pinned } })
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(next.general.lightModel).toEqual(pinned)
    const back = mergeSettings(
      next,
      validateSettingsPatch({ general: { lightModel: { mode: 'session' } } }),
    )
    expect(back.general.lightModel).toEqual({ mode: 'session' })
    for (const choice of bad) {
      expect(() => validateSettingsPatch({ general: { lightModel: choice } })).toThrow()
    }
  })

  it('is kept by the host and reaches its agent host', () => {
    expect(splitSettingsPatch({ general: { lightModel: { mode: 'session' } } })).toEqual({
      host: { general: { lightModel: { mode: 'session' } } },
      client: null,
    })
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      general: { lightModel: { mode: 'session' } },
    })
    expect(hostSettings(settings, 'en').lightModel).toEqual({ mode: 'session' })
  })
})

describe('letting agents type passwords', () => {
  it('is off until the user turns it on', () => {
    expect(DEFAULT_SETTINGS.general.agentPasswords).toBe(false)
    expect(hostSettings(DEFAULT_SETTINGS, 'en').agentPasswords).toBe(false)
  })

  it('is kept by the host, so a client never turns it on for its own computer instead', () => {
    expect(splitSettingsPatch({ general: { agentPasswords: true } })).toEqual({
      host: { general: { agentPasswords: true } },
      client: null,
    })
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { agentPasswords: true } })
    expect(hostSettings(settings, 'en').agentPasswords).toBe(true)
  })
})

describe('continuing after a plan limit resets', () => {
  it('is kept by the host, so a client changes the value its sessions follow', () => {
    expect(splitSettingsPatch({ general: { continueAfterLimit: false } })).toEqual({
      host: { general: { continueAfterLimit: false } },
      client: null,
    })
    const host = mergeSettings(DEFAULT_SETTINGS, { general: { continueAfterLimit: false } })
    expect(hostSettingsPart(host).general.continueAfterLimit).toBe(false)
    const shown = withHostSettings(structuredClone(DEFAULT_SETTINGS), hostSettingsPart(host))
    expect(shown.general.continueAfterLimit).toBe(false)
    expect(hostSettings(host, 'en').continueAfterLimit).toBe(false)
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

describe("a plugin's items in a patch", () => {
  const skill = {
    id: 'plugin:p0123456789ab:review',
    name: 'review',
    description: 'Reviews a change.',
    source: 'plugin',
    origin: 'review-kit',
    version: '1.0.0',
    agents: 'all',
    on: true,
  }
  const server = {
    id: 'plugin:p0123456789ab:tracker',
    name: 'tracker',
    title: 'tracker',
    source: 'plugin',
    version: null,
    spec: { type: 'stdio', command: '/data/plugins/bin/server', args: [], env: [] },
    agents: 'all',
    on: true,
  }

  it('keeps a skill and a server by the plugin that brought them', () => {
    expect(validateSettingsPatch({ marketplace: { skillsEdit: { put: [skill] } } })).toEqual({
      marketplace: { skillsEdit: { put: [skill] } },
    })
    expect(validateSettingsPatch({ marketplace: { mcpEdit: { put: [server] } } })).toEqual({
      marketplace: { mcpEdit: { put: [server] } },
    })
  })

  it('refuses an id that names no plugin, and an origin that is no plugin name', () => {
    for (const id of ['plugin:review', 'plugin:p01:review', 'plugin:p0123456789ab:../x', 'x']) {
      expect(() => validateSettingsPatch({ marketplace: { skills: [{ ...skill, id }] } })).toThrow()
      expect(() => validateSettingsPatch({ marketplace: { mcp: [{ ...server, id }] } })).toThrow()
    }
    expect(() =>
      validateSettingsPatch({ marketplace: { skills: [{ ...skill, origin: '/etc/passwd' }] } }),
    ).toThrow()
    expect(() =>
      validateSettingsPatch({ marketplace: { skills: [{ ...skill, source: 'kettu' }] } }),
    ).toThrow()
  })
})

describe('removing what a plugin brought', () => {
  const skill = {
    id: 'plugin:p0123456789ab:review',
    name: 'review',
    description: 'Reviews a change.',
    source: 'plugin' as const,
    origin: 'review-kit',
    version: '1.0.0',
    agents: 'all' as const,
    on: true,
  }
  const other = {
    ...skill,
    id: 'github:owner/repo',
    name: 'other',
    source: 'github' as const,
    origin: 'https://github.com/owner/repo',
  }
  const base = mergeSettings(
    DEFAULT_SETTINGS,
    {
      marketplace: { skills: [skill, other] as never },
    },
    { plugins: true },
  )

  it('refuses a remove, or a list without it, from anyone but the plugin service', () => {
    const remove = validateSettingsPatch({ marketplace: { skillsEdit: { remove: [skill.id] } } })
    expect(() => mergeSettings(base, remove)).toThrow(/review/)
    const whole = validateSettingsPatch({ marketplace: { skills: [other] } })
    expect(() => mergeSettings(base, whole)).toThrow(/review/)
  })

  it('lets the plugin service remove it', () => {
    const remove = validateSettingsPatch({ marketplace: { skillsEdit: { remove: [skill.id] } } })
    const next = mergeSettings(base, remove, { plugins: true })
    expect(next.marketplace.skills.map((item) => item.id)).toEqual([other.id])
  })

  it('still lets anyone turn it off and remove other skills', () => {
    const off = validateSettingsPatch({
      marketplace: { skillsEdit: { put: [{ ...skill, on: false }], remove: [other.id] } },
    })
    const next = mergeSettings(base, off)
    expect(next.marketplace.skills).toEqual([{ ...skill, on: false }])
  })

  it('lets anyone choose its agents, in an edit and in a whole list', () => {
    const edit = validateSettingsPatch({
      marketplace: { skillsEdit: { put: [{ ...skill, agents: ['codex'] }] } },
    })
    expect(mergeSettings(base, edit).marketplace.skills[0]).toEqual({
      ...skill,
      agents: ['codex'],
    })
    const whole = validateSettingsPatch({
      marketplace: { skills: [{ ...skill, on: false, agents: ['codex'] }, other] },
    })
    expect(mergeSettings(base, whole).marketplace.skills[0]).toEqual({
      ...skill,
      on: false,
      agents: ['codex'],
    })
  })

  it('takes nothing else of it from anyone but the plugin service', () => {
    const edit = validateSettingsPatch({
      marketplace: {
        skillsEdit: { put: [{ ...skill, description: 'Other.', version: '9.9.9', on: false }] },
      },
    })
    expect(mergeSettings(base, edit).marketplace.skills[0]).toEqual({ ...skill, on: false })
    expect(mergeSettings(base, edit, { plugins: true }).marketplace.skills[0]).toMatchObject({
      description: 'Other.',
      version: '9.9.9',
    })
  })

  it('refuses to add one, but for the plugin service', () => {
    const added = { ...skill, id: 'plugin:p0123456789ab:audit', name: 'audit' }
    const add = validateSettingsPatch({ marketplace: { skillsEdit: { put: [added] } } })
    expect(() => mergeSettings(base, add)).toThrow(/audit/)
    expect(
      mergeSettings(base, add, { plugins: true }).marketplace.skills.map((i) => i.id),
    ).toContain(added.id)
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

describe('edits to the servers and skills Kettu keeps', () => {
  const server = (id: string, name = id, over: Record<string, unknown> = {}) => ({
    id: `kettu:${id.padEnd(10, 'x')}`,
    name,
    title: name,
    source: 'kettu',
    version: '1.0.0',
    spec: { type: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], env: [] },
    agents: 'all',
    on: true,
    ...over,
  })
  const skill = (id: string, name = id) => ({
    id: `kettu:${id.padEnd(10, 'x')}`,
    name,
    description: 'A skill.',
    source: 'kettu',
    origin: `@amigoer/${name}`,
    version: '1.0.0',
    agents: 'all',
    on: true,
  })
  const names = (list: { name: string }[]) => list.map((item) => item.name)

  it('adds each server to the list the host holds, not the one its sender read', async () => {
    const store = await SettingsStore.load(dir)
    store.update({ marketplace: { mcp: [server('first')] } })
    // Two installs that began from a list holding only the first server.
    store.update({ marketplace: { mcpEdit: { put: [server('second')] } } })
    store.update({ marketplace: { mcpEdit: { put: [server('third')] } } })
    expect(names(store.get().marketplace.mcp)).toEqual(['first', 'second', 'third'])
  })

  it('adds each skill to the list the host holds', async () => {
    const store = await SettingsStore.load(dir)
    store.update({ marketplace: { skillsEdit: { put: [skill('one')] } } })
    store.update({ marketplace: { skillsEdit: { put: [skill('two')] } } })
    expect(names(store.get().marketplace.skills)).toEqual(['one', 'two'])
  })

  it('replaces an entry in place by its id and removes by id', async () => {
    const store = await SettingsStore.load(dir)
    store.update({
      marketplace: { mcp: [server('first'), server('second'), server('third')] },
    })
    store.update({
      marketplace: { mcpEdit: { put: [server('second', 'second', { on: false })] } },
    })
    expect(store.get().marketplace.mcp.map((s) => [s.name, s.on])).toEqual([
      ['first', true],
      ['second', false],
      ['third', true],
    ])
    store.update({ marketplace: { mcpEdit: { remove: [server('first').id, 'kettu:gone'] } } })
    expect(names(store.get().marketplace.mcp)).toEqual(['second', 'third'])
  })

  it('refuses an edit that repeats another entry’s name and changes nothing', async () => {
    const store = await SettingsStore.load(dir)
    store.update({ marketplace: { mcp: [server('first', 'notes')] } })
    expect(() =>
      store.update({ marketplace: { mcpEdit: { put: [server('second', 'notes')] } } }),
    ).toThrow(/repeats/)
    expect(names(store.get().marketplace.mcp)).toEqual(['notes'])
    store.update({ marketplace: { skillsEdit: { put: [skill('one', 'greeter')] } } })
    expect(() =>
      store.update({ marketplace: { skillsEdit: { put: [skill('two', 'greeter')] } } }),
    ).toThrow(/repeats/)
    expect(names(store.get().marketplace.skills)).toEqual(['greeter'])
  })

  it('still takes a whole list from a client that sends one', async () => {
    const store = await SettingsStore.load(dir)
    store.update({ marketplace: { mcp: [server('first'), server('second')] } })
    store.update({ marketplace: { mcp: [server('third')] } })
    expect(names(store.get().marketplace.mcp)).toEqual(['third'])
  })

  it('checks the entries and ids an edit carries', () => {
    expect(() =>
      validateSettingsPatch({ marketplace: { mcpEdit: { put: [{ ...server('a'), id: 'x' }] } } }),
    ).toThrow()
    expect(() =>
      validateSettingsPatch({ marketplace: { mcpEdit: { put: [server('a'), server('a')] } } }),
    ).toThrow(/repeats/)
    expect(() => validateSettingsPatch({ marketplace: { mcpEdit: { remove: [3] } } })).toThrow()
    expect(() => validateSettingsPatch({ marketplace: { mcpEdit: { drop: [] } } })).toThrow()
    expect(() => validateSettingsPatch({ marketplace: { skillsEdit: 'all' } })).toThrow()
  })
})

describe('the terminal font', () => {
  it('uses the theme’s code font until a face is named', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().terminal.fontFamily).toBeUndefined()
  })

  it('keeps a stored face and drops one that could break out of a font stack on load', async () => {
    await save({ version: 1, terminal: { fontSize: 14, fontFamily: 'Maple Mono NF CN' } })
    expect((await SettingsStore.load(dir)).get().terminal).toEqual({
      fontSize: 14,
      fontFamily: 'Maple Mono NF CN',
    })
    for (const bad of ['', ' padded ', 'A", evil', "A'; x", 'A\nB', 'a{b}', 7, 'x'.repeat(101)]) {
      await save({ version: 1, terminal: { fontSize: 14, fontFamily: bad } })
      expect((await SettingsStore.load(dir)).get().terminal).toEqual({ fontSize: 14 })
    }
  })

  it('takes one face name or null in a change and refuses the rest', () => {
    expect(validateSettingsPatch({ terminal: { fontFamily: 'Maple Mono NF CN' } })).toEqual({
      terminal: { fontFamily: 'Maple Mono NF CN' },
    })
    expect(validateSettingsPatch({ terminal: { fontFamily: null } })).toEqual({
      terminal: { fontFamily: null },
    })
    for (const bad of ['', ' padded ', 'A", evil', 'A, B', 'url(x)', 'A;B', 3]) {
      expect(() => validateSettingsPatch({ terminal: { fontFamily: bad } })).toThrow()
    }
  })

  it('sets the face in a change and clears it with null', () => {
    const named = mergeSettings(DEFAULT_SETTINGS, { terminal: { fontFamily: 'Menlo' } })
    expect(named.terminal.fontFamily).toBe('Menlo')
    const cleared = mergeSettings(named, { terminal: { fontFamily: null } })
    expect('fontFamily' in cleared.terminal).toBe(false)
  })

  it('stays with the window that draws the terminal, never on the host', () => {
    const { host, client } = splitSettingsPatch({ terminal: { fontFamily: 'Menlo' } })
    expect(host).toBeNull()
    expect(client).toEqual({ terminal: { fontFamily: 'Menlo' } })
  })
})

describe('the fonts the user picks', () => {
  it('keeps the theme’s faces until one is named', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().appearance.fonts).toEqual({})
  })

  it('keeps stored faces and drops a set that could break out of a font stack on load', async () => {
    const fonts = { ui: 'Segoe UI', prose: 'Microsoft YaHei', code: 'Maple Mono NF CN' }
    await save({ version: 1, appearance: { fonts } })
    expect((await SettingsStore.load(dir)).get().appearance.fonts).toEqual(fonts)
    for (const bad of [
      { code: 'A", evil' },
      { ui: '' },
      { prose: "A'; x" },
      { code: 7 },
      { heading: 'Inter' },
      ['Inter'],
      'Inter',
      null,
    ]) {
      await save({ version: 1, appearance: { fonts: bad } })
      expect((await SettingsStore.load(dir)).get().appearance.fonts).toEqual({})
    }
  })

  it('takes a set of face names in a change and refuses the rest', () => {
    expect(validateSettingsPatch({ appearance: { fonts: { code: 'Maple Mono NF CN' } } })).toEqual({
      appearance: { fonts: { code: 'Maple Mono NF CN' } },
    })
    expect(validateSettingsPatch({ appearance: { fonts: {} } })).toEqual({
      appearance: { fonts: {} },
    })
    for (const bad of [
      { code: 'A, B' },
      { ui: 'url(x)' },
      { prose: null },
      { mono: 'Menlo' },
      null,
      'Menlo',
    ]) {
      expect(() => validateSettingsPatch({ appearance: { fonts: bad } })).toThrow()
    }
  })

  it('replaces the whole set in a change', () => {
    const both = mergeSettings(DEFAULT_SETTINGS, {
      appearance: { fonts: { ui: 'Segoe UI', code: 'Menlo' } },
    })
    expect(both.appearance.fonts).toEqual({ ui: 'Segoe UI', code: 'Menlo' })
    const one = mergeSettings(both, { appearance: { fonts: { code: 'Menlo' } } })
    expect(one.appearance.fonts).toEqual({ code: 'Menlo' })
  })

  it('stays with the window that draws them, never on the host', () => {
    const { host, client } = splitSettingsPatch({ appearance: { fonts: { code: 'Menlo' } } })
    expect(host).toBeNull()
    expect(client).toEqual({ appearance: { fonts: { code: 'Menlo' } } })
  })
})

describe('the pages the sidebar lists', () => {
  const ALL = ['overview', 'artifacts', 'routines', 'marketplace', 'usage']

  it('shows every page in its default order until the user changes them', async () => {
    const { appearance } = (await SettingsStore.load(dir)).get()
    expect(appearance.sidebarOrder).toEqual(ALL)
    expect(appearance.sidebarHidden).toEqual([])
  })

  it('keeps a stored order and hidden pages on load', async () => {
    const order = ['usage', 'marketplace', 'overview', 'routines', 'artifacts']
    await save({ version: 1, appearance: { sidebarOrder: order, sidebarHidden: ['usage'] } })
    const { appearance } = (await SettingsStore.load(dir)).get()
    expect(appearance.sidebarOrder).toEqual(order)
    expect(appearance.sidebarHidden).toEqual(['usage'])
  })

  it('drops unknown and repeated pages and puts a missing one at its default place', async () => {
    await save({
      version: 1,
      appearance: {
        sidebarOrder: ['usage', 'later-page', 'overview', 'usage', 7, 'routines', 'marketplace'],
        sidebarHidden: ['routines', 'later-page', 'routines', null],
      },
    })
    const { appearance } = (await SettingsStore.load(dir)).get()
    expect(appearance.sidebarOrder).toEqual([
      'usage',
      'overview',
      'artifacts',
      'routines',
      'marketplace',
    ])
    expect(appearance.sidebarHidden).toEqual(['routines'])
  })

  it('places pages missing before every kept one at the start', async () => {
    await save({ version: 1, appearance: { sidebarOrder: ['marketplace', 'usage'] } })
    expect((await SettingsStore.load(dir)).get().appearance.sidebarOrder).toEqual(ALL)
  })

  it('goes back to the defaults for a value that is not a list', async () => {
    for (const bad of ['usage', { usage: true }, null, 3]) {
      await save({ version: 1, appearance: { sidebarOrder: bad, sidebarHidden: bad } })
      const { appearance } = (await SettingsStore.load(dir)).get()
      expect(appearance.sidebarOrder).toEqual(ALL)
      expect(appearance.sidebarHidden).toEqual([])
    }
  })

  it('takes an order of every page once and hidden pages in a change', () => {
    const order = ['routines', 'overview', 'usage', 'artifacts', 'marketplace']
    expect(
      validateSettingsPatch({ appearance: { sidebarOrder: order, sidebarHidden: ['overview'] } }),
    ).toEqual({ appearance: { sidebarOrder: order, sidebarHidden: ['overview'] } })
    expect(validateSettingsPatch({ appearance: { sidebarHidden: ALL } })).toEqual({
      appearance: { sidebarHidden: ALL },
    })
    expect(validateSettingsPatch({ appearance: { sidebarHidden: [] } })).toEqual({
      appearance: { sidebarHidden: [] },
    })
  })

  it('refuses an order that leaves out, repeats or adds a page', () => {
    for (const bad of [
      ['overview', 'artifacts', 'routines', 'marketplace'],
      ['overview', 'artifacts', 'routines', 'marketplace', 'usage', 'usage'],
      ['overview', 'artifacts', 'routines', 'marketplace', 'newSession'],
      ['overview', 'artifacts', 'routines', 'marketplace', 'usage', 'later-page'],
      'overview',
      null,
    ]) {
      expect(() => validateSettingsPatch({ appearance: { sidebarOrder: bad } })).toThrow()
    }
  })

  it('refuses hidden pages that repeat or name what the sidebar cannot hide', () => {
    for (const bad of [['usage', 'usage'], ['newSession'], ['later-page'], [3], 'usage', null]) {
      expect(() => validateSettingsPatch({ appearance: { sidebarHidden: bad } })).toThrow()
    }
  })

  it('replaces each list whole in a change', () => {
    const hidden = mergeSettings(DEFAULT_SETTINGS, {
      appearance: { sidebarHidden: ['usage', 'overview'] },
    })
    expect(hidden.appearance.sidebarHidden).toEqual(['usage', 'overview'])
    const shown = mergeSettings(hidden, { appearance: { sidebarHidden: ['overview'] } })
    expect(shown.appearance.sidebarHidden).toEqual(['overview'])
    expect(shown.appearance.sidebarOrder).toEqual(ALL)
  })
})

describe('the relay a host uses', () => {
  const own = { url: 'https://relay.example.com', pin: null }

  it('reads a file from before the own relay, whose relay is a switch', async () => {
    await save({ version: 1, remote: { relay: true } })
    expect((await SettingsStore.load(dir)).get().remote.relay).toBe('kettu')
    await save({ version: 1, remote: { relay: false } })
    expect((await SettingsStore.load(dir)).get().remote.relay).toBe('off')
  })

  it('keeps the own relay with its address, and goes without a relay without one', async () => {
    await save({ version: 1, remote: { relay: 'own', ownRelay: own } })
    expect((await SettingsStore.load(dir)).get().remote).toMatchObject({
      relay: 'own',
      ownRelay: own,
    })
    await save({ version: 1, remote: { relay: 'own' } })
    expect((await SettingsStore.load(dir)).get().remote.relay).toBe('off')
    // A Kettu address or plain http to another computer is never kept as the owner's relay.
    for (const url of ['https://relay.kettu.sh', 'http://203.0.113.7:8080']) {
      await save({ version: 1, remote: { relay: 'own', ownRelay: { url, pin: null } } })
      expect((await SettingsStore.load(dir)).get().remote).toMatchObject({
        relay: 'off',
        ownRelay: null,
      })
    }
  })

  it('takes the switch of older clients and the choice in a change', () => {
    const before = structuredClone(DEFAULT_SETTINGS)
    expect(
      mergeSettings(before, validateSettingsPatch({ remote: { relay: false } })).remote.relay,
    ).toBe('off')
    expect(
      mergeSettings(before, validateSettingsPatch({ remote: { relay: true } })).remote.relay,
    ).toBe('kettu')
    expect(() => validateSettingsPatch({ remote: { relay: 'elsewhere' } })).toThrow()
    // The own relay is chosen only once its check passed, which gives it its address.
    expect(() =>
      mergeSettings(before, validateSettingsPatch({ remote: { relay: 'own' } })),
    ).toThrow()
    expect(() => validateSettingsPatch({ remote: { ownRelay: own } })).toThrow()
    const checked = withOwnRelay(before, own)
    expect(checked.remote).toMatchObject({ relay: 'own', ownRelay: own })
    expect(
      mergeSettings(checked, validateSettingsPatch({ remote: { relay: 'kettu' } })).remote,
    ).toMatchObject({ relay: 'kettu', ownRelay: own })
    expect(() => withOwnRelay(before, { url: 'https://relay.kettu.sh', pin: null })).toThrow()
  })

  it('holds direct connections on with no relay, and frees them on the own relay', () => {
    const on = structuredClone(DEFAULT_SETTINGS)
    on.remote.enabled = true
    on.remote.direct.enabled = false
    expect(effectiveDirect({ ...on, remote: { ...on.remote, relay: 'off' } }, true).enabled).toBe(
      true,
    )
    expect(
      effectiveDirect({ ...on, remote: { ...on.remote, relay: 'kettu' } }, false).enabled,
    ).toBe(true)
    expect(
      effectiveDirect({ ...on, remote: { ...on.remote, relay: 'own', ownRelay: own } }, false)
        .enabled,
    ).toBe(false)
  })

  it('tells older clients a switch and newer ones the choice', () => {
    const file = withOwnRelay(structuredClone(DEFAULT_SETTINGS), own)
    const part = hostSettingsPart(file)
    expect(part.remote).toMatchObject({ relay: false, relayChoice: 'own', ownRelay: own })
    expect(withHostSettings(structuredClone(DEFAULT_SETTINGS), part).remote).toMatchObject({
      relay: 'own',
      ownRelay: own,
    })
    // A host from before sends its switch alone.
    const older = { ...part, remote: { ...part.remote, relay: true } }
    delete (older.remote as { relayChoice?: unknown }).relayChoice
    delete (older.remote as { ownRelay?: unknown }).ownRelay
    expect(withHostSettings(structuredClone(DEFAULT_SETTINGS), older).remote).toMatchObject({
      relay: 'kettu',
      ownRelay: null,
    })
  })
})
