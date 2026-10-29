import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
