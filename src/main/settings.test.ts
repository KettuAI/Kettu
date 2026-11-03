import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { JsonFileWriter } from './json-file'
import { createLogger } from './log'
import { SettingsStore } from './settings'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-settings-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function readSettings(): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
}

describe('SettingsStore', () => {
  it('registers only defaults with user settings or references during a one-time migration', async () => {
    await mkdir(join(dir, 'state'))
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        agents: {
          codex: { binaryPath: '/opt/codex' },
          'claude-code': { configDir: '/my/config' },
          opencode: { hidden: true },
        },
        general: { defaultAgent: 'pi' },
        mcp: { kettu: { off: ['gemini'] } },
      }),
    )
    await writeFile(
      join(dir, 'state', 'sessions.json'),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: 'old',
            agentId: 'qwen',
            acpSessionId: 'external',
            projectPath: '/project',
            title: null,
            createdAt: 1,
            updatedAt: 1,
            lastViewedAt: null,
            parentId: null,
            origin: 'user',
            description: null,
            branch: null,
            archivedAt: 2,
          },
        ],
      }),
    )
    await writeFile(
      join(dir, 'state', 'agent-options.json'),
      JSON.stringify({
        version: 1,
        agents: {
          codex: { config: [], remembered: { model: 'chosen' } },
          opencode: { config: [{ id: 'model' }], remembered: {} },
        },
      }),
    )
    const store = await SettingsStore.load(dir)
    expect(store.get().agents).toMatchObject({
      codex: { enabled: true, binaryPath: '/opt/codex' },
      'claude-code': { enabled: true, configDir: '/my/config' },
      pi: { enabled: true },
      gemini: { enabled: true },
      qwen: { enabled: true },
    })
    expect(store.get().agents.opencode?.enabled).not.toBe(true)
    expect(store.get()).toHaveProperty('agentRegistrationVersion', 1)
    store.removeAgent('qwen')
    await store.flush()
    const reloaded = await SettingsStore.load(dir)
    expect(reloaded.get().agents['qwen']?.enabled).toBe(false)
    expect(await readFile(join(dir, 'state', 'sessions.json'), 'utf8')).toContain('archivedAt')
  })

  it('does not register a harness merely because its binary was picked', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, agents: { codex: { binaryPath: '/opt/codex' } } }),
    )
    const store = await SettingsStore.load(dir)
    expect(store.get()).toHaveProperty('agentRegistrationVersion', 1)
    expect(store.get().agents.codex).toEqual({ binaryPath: '/opt/codex' })
    store.update({ agents: { codex: { enabled: true, hidden: false } } })
    expect(store.get().agents.codex?.enabled).toBe(true)
    store.removeAgent('codex')
    expect(store.get().agents.codex).toEqual({ binaryPath: '/opt/codex', enabled: false })
    await store.flush()
  })

  it('keeps every harness when the history cannot be read, without touching the files', async () => {
    const old = JSON.stringify({ version: 1 })
    await writeFile(join(dir, 'settings.json'), old)
    await mkdir(join(dir, 'state'))
    await writeFile(join(dir, 'state', 'sessions.json'), '{ broken')
    const store = await SettingsStore.load(dir)
    expect(store.get().agents['fake-agent']?.enabled).toBe(true)
    expect(store.get().agents['claude-code']?.enabled).toBe(true)
    expect(store.get()).toHaveProperty('agentRegistrationVersion', 1)
    await store.flush()
    expect(await readFile(join(dir, 'state', 'sessions.json'), 'utf8')).toBe('{ broken')
  })

  it('starts from the defaults without a file and writes nothing until a change', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    await store.flush()
    expect(await readdir(dir)).toEqual([])
  })

  it('writes a change and tells listeners which sections changed', async () => {
    const store = await SettingsStore.load(dir)
    const seen: string[][] = []
    store.onChange((_, changed) => seen.push([...changed]))
    store.update({ appearance: { theme: 'dark' } })
    store.update({ appearance: { theme: 'dark' } })
    await store.flush()
    expect(seen).toEqual([['appearance']])
    expect(await readSettings()).toMatchObject({ version: 1, appearance: { theme: 'dark' } })
  })

  it('changes nothing for an invalid patch', async () => {
    const store = await SettingsStore.load(dir)
    expect(() => store.update({ appearance: { theme: 'dark', font: 'x' } })).toThrow(
      'Unknown setting "appearance.font"',
    )
    expect(store.get().appearance.theme).toBe('system')
  })

  it('stores programs picked in a dialog', async () => {
    const store = await SettingsStore.load(dir)
    store.setAgentBinary('opencode', '/opt/opencode')
    store.setShellPath('/bin/fish')
    await store.flush()
    expect(await readSettings()).toMatchObject({
      agents: { opencode: { binaryPath: '/opt/opencode' } },
      terminal: { shellPath: '/bin/fish', fontSize: 13 },
    })
  })

  it('moves an unreadable file aside and uses the defaults', async () => {
    await writeFile(join(dir, 'settings.json'), '{ not json')
    const store = await SettingsStore.load(dir)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    await store.flush()
    const files = await readdir(dir)
    const corrupt = files.find((file) => /^settings\.corrupt-\d+\.json$/.test(file))
    expect(corrupt).toBeDefined()
    expect(await readFile(join(dir, corrupt!), 'utf8')).toBe('{ not json')
  })

  it('keeps the valid values of a partly invalid file', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, general: { sendKey: 'mod-enter' }, appearance: { theme: 9 } }),
    )
    const store = await SettingsStore.load(dir)
    expect(store.get().general.sendKey).toBe('mod-enter')
    expect(store.get().appearance.theme).toBe('system')
    await store.flush()
    expect((await readdir(dir)).some((file) => file.startsWith('settings.corrupt-'))).toBe(true)
    expect(await readSettings()).toMatchObject({ general: { sendKey: 'mod-enter' } })
  })

  it('turns off a stored account mask, because the settings page no longer has that control', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, agentRegistrationVersion: 1, privacy: { hideAccount: true } }),
    )
    const store = await SettingsStore.load(dir)
    expect(store.get().privacy.hideAccount).toBe(false)
    await store.flush()
    expect(await readSettings()).toMatchObject({ privacy: { hideAccount: false } })
  })

  it('picks a dynamic port the first time direct connections turn on, and keeps it', async () => {
    const store = await SettingsStore.load(dir)
    store.update({ remote: { direct: { enabled: true } } })
    const port = store.get().remote.direct.port
    expect(port).toBeGreaterThanOrEqual(49152)
    expect(port).toBeLessThanOrEqual(65535)
    store.update({ remote: { direct: { enabled: false } } })
    store.update({ remote: { direct: { enabled: true } } })
    expect(store.get().remote.direct.port).toBe(port)
    store.update({ remote: { direct: { port: 8022 } } })
    expect(store.get().remote.direct.port).toBe(8022)
    await store.flush()
    expect(await readSettings()).toMatchObject({
      remote: { direct: { enabled: true, port: 8022 } },
    })
  })

  it('gives a file that turns direct connections on by hand its port, and saves it', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, remote: { direct: { enabled: true } } }),
    )
    const store = await SettingsStore.load(dir)
    const port = store.get().remote.direct.port
    expect(port).toBeGreaterThanOrEqual(49152)
    await store.flush()
    expect(await readSettings()).toMatchObject({ remote: { direct: { enabled: true, port } } })
    expect(await readdir(dir)).toEqual(['settings.json'])
  })

  it('never overwrites a file from a newer version', async () => {
    const newer = JSON.stringify({ version: 2, appearance: { theme: 'light' }, future: true })
    await writeFile(join(dir, 'settings.json'), newer)
    const store = await SettingsStore.load(dir)
    expect(store.get().appearance.theme).toBe('light')
    store.update({ appearance: { theme: 'dark' } })
    expect(store.get().appearance.theme).toBe('dark')
    await store.flush()
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(newer)
  })
})

describe('JsonFileWriter', () => {
  it('debounces writes so only the latest value lands, through a temporary file', async () => {
    vi.useFakeTimers()
    const path = join(dir, 'state.json')
    const writer = new JsonFileWriter(path, createLogger('test'), 500)
    writer.schedule({ n: 1 })
    writer.schedule({ n: 2 })
    vi.advanceTimersByTime(499)
    expect(await readdir(dir)).toEqual([])
    vi.useRealTimers()
    await writer.flush()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ n: 2 })
    expect(await readdir(dir)).toEqual(['state.json'])
  })
})
