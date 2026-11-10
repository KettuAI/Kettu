import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigOption } from '@shared/thread'
import {
  listedModels,
  readClaudeSettings,
  writeClaudeSetting,
  type ListedModel,
} from './user-settings'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-claude-settings-'))
  file = path.join(dir, 'settings.json')
})

afterEach(() => rm(dir, { recursive: true, force: true }))

async function put(value: unknown): Promise<void> {
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
}

async function saved(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8'))
}

const sonnet: ListedModel = { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }
const opus: ListedModel = { id: 'claude-opus-5-5', name: 'Opus 5.5' }

describe("a Claude Code agent's settings file", () => {
  it('reads a window by canonical model name and leaves unsaved models on Auto', async () => {
    await put({ modelSettings: { 'claude-sonnet-5-5-20261001': { autoCompactWindow: 500000 } } })
    const settings = await readClaudeSettings(file, [sonnet, opus])
    expect(settings.compact).toEqual([
      { model: 'claude-sonnet-5-5', name: 'Sonnet 5.5', window: 500000 },
      { model: 'claude-opus-5-5', name: 'Opus 5.5', window: null },
    ])
  })

  it('lists a saved window for a model the agent no longer lists, but not an Auto one', async () => {
    await put({
      modelSettings: {
        'claude-old-1': { autoCompactWindow: 300000 },
        'claude-old-2': { autoCompactWindow: 'auto' },
        'claude-old-3': { effortLevel: 'low' },
      },
    })
    const settings = await readClaudeSettings(file, [])
    expect(settings.compact).toEqual([{ model: 'claude-old-1', name: null, window: 300000 }])
  })

  it('reads a missing file as nothing saved', async () => {
    expect(await readClaudeSettings(file, [sonnet])).toEqual({
      compact: [{ model: sonnet.id, name: sonnet.name, window: null }],
      promptCacheTtl: null,
    })
  })

  it('writes a window and a duration and keeps everything else', async () => {
    const other = { extraKnownMarketplaces: { a: { source: { repo: 'x/y' } } }, env: { A: '1' } }
    await put({ ...other, modelSettings: { [sonnet.id]: { effortLevel: 'low' } } })
    await writeClaudeSetting(file, {
      setting: 'autoCompactWindow',
      model: sonnet.id,
      value: 400000,
    })
    await writeClaudeSetting(file, { setting: 'promptCacheTtl', value: '1h' })
    expect(await saved()).toEqual({
      ...other,
      modelSettings: { [sonnet.id]: { effortLevel: 'low', autoCompactWindow: 400000 } },
      promptCacheTtl: '1h',
    })
  })

  it('adds a model under its canonical name and creates the file when it is missing', async () => {
    await writeClaudeSetting(file, {
      setting: 'autoCompactWindow',
      model: 'Claude-Sonnet-5-5[1m]',
      value: 200000,
    })
    expect(await saved()).toEqual({ modelSettings: { [sonnet.id]: { autoCompactWindow: 200000 } } })
  })

  it('sets every spelling of a model in the file', async () => {
    await put({
      modelSettings: {
        [sonnet.id]: { autoCompactWindow: 100000 },
        'claude-sonnet-5-5-20261001': { autoCompactWindow: 200000 },
      },
    })
    await writeClaudeSetting(file, {
      setting: 'autoCompactWindow',
      model: sonnet.id,
      value: 300000,
    })
    expect(await saved()).toEqual({
      modelSettings: {
        [sonnet.id]: { autoCompactWindow: 300000 },
        'claude-sonnet-5-5-20261001': { autoCompactWindow: 300000 },
      },
    })
  })

  it('removes a key for Auto and the empty parents with it, but not what else is in them', async () => {
    await put({
      promptCacheTtl: '5m',
      modelSettings: {
        [sonnet.id]: { autoCompactWindow: 500000 },
        [opus.id]: { autoCompactWindow: 200000, effortLevel: 'high' },
      },
    })
    await writeClaudeSetting(file, { setting: 'autoCompactWindow', model: sonnet.id, value: null })
    await writeClaudeSetting(file, { setting: 'autoCompactWindow', model: opus.id, value: null })
    await writeClaudeSetting(file, { setting: 'promptCacheTtl', value: null })
    expect(await saved()).toEqual({ modelSettings: { [opus.id]: { effortLevel: 'high' } } })
    await writeClaudeSetting(file, {
      setting: 'autoCompactWindow',
      model: sonnet.id,
      value: 150000,
    })
    await writeClaudeSetting(file, { setting: 'autoCompactWindow', model: sonnet.id, value: null })
    expect(await saved()).toEqual({ modelSettings: { [opus.id]: { effortLevel: 'high' } } })
  })

  it('drops modelSettings once its last window is removed', async () => {
    await put({ theme: 'dark', modelSettings: { [sonnet.id]: { autoCompactWindow: 500000 } } })
    await writeClaudeSetting(file, { setting: 'autoCompactWindow', model: sonnet.id, value: null })
    expect(await saved()).toEqual({ theme: 'dark' })
  })

  it('does not touch the file when Auto changes nothing', async () => {
    await writeClaudeSetting(file, { setting: 'autoCompactWindow', model: sonnet.id, value: null })
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })

  it.each([99999, 1000001, 250000.5, Number.NaN])('refuses the window %s', async (value) => {
    await expect(
      writeClaudeSetting(file, { setting: 'autoCompactWindow', model: sonnet.id, value }),
    ).rejects.toThrow('The window must be from')
  })

  it('refuses a model with spaces and a duration it does not know', async () => {
    await expect(
      writeClaudeSetting(file, { setting: 'autoCompactWindow', model: 'a b', value: 200000 }),
    ).rejects.toThrow('one word')
    await expect(
      // @ts-expect-error a value the contract does not allow
      writeClaudeSetting(file, { setting: 'promptCacheTtl', value: '2h' }),
    ).rejects.toThrow('5m or 1h')
  })

  it('never rewrites a file it cannot read as a settings object', async () => {
    await put('{ "modelSettings": ')
    await expect(
      writeClaudeSetting(file, { setting: 'promptCacheTtl', value: '1h' }),
    ).rejects.toThrow('not valid JSON')
    await expect(readClaudeSettings(file, [])).rejects.toThrow('not valid JSON')
    expect(await readFile(file, 'utf8')).toBe('{ "modelSettings": ')

    await put('[]')
    await expect(
      writeClaudeSetting(file, { setting: 'promptCacheTtl', value: '1h' }),
    ).rejects.toThrow('does not hold a JSON object')
  })

  it('keeps a modelSettings that is not an object instead of replacing it', async () => {
    await put({ modelSettings: 'oops' })
    await expect(
      writeClaudeSetting(file, { setting: 'autoCompactWindow', model: sonnet.id, value: null }),
    ).rejects.toThrow('not an object')
    expect(await saved()).toEqual({ modelSettings: 'oops' })
  })
})

describe('the models a Claude Code agent lists', () => {
  const option = (choices: NonNullable<ConfigOption['choices']>): ConfigOption[] => [
    { id: 'model', name: 'Model', category: 'model', type: 'select', value: 'default', choices },
  ]

  it('are one row each by the model they follow, without the row shown as another', () => {
    const models = listedModels(
      option([
        { value: 'default', name: 'Default', modelId: 'claude-sonnet-5-5', shownAs: 'sonnet' },
        { value: 'sonnet', name: 'Sonnet 5.5', modelId: 'claude-sonnet-5-5' },
        { value: 'sonnet[1m]', name: 'Sonnet 5.5 (1M)', modelId: 'claude-sonnet-5-5[1m]' },
        { value: 'claude-opus-4-7', name: 'Opus 4.7', modelId: 'claude-opus-4-7' },
        { value: 'mystery', name: 'Mystery' },
      ]),
    )
    expect(models).toEqual([
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
      { id: 'claude-opus-4-7', name: 'Opus 4.7' },
    ])
  })

  it('are none when the agent has not listed any', () => {
    expect(listedModels(undefined)).toEqual([])
    expect(listedModels([])).toEqual([])
  })
})
