import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readConfig, setConfigValue } from './config-files'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-config-files-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

async function file(name: string, text?: string): Promise<string> {
  const at = path.join(dir, name)
  if (text !== undefined) await writeFile(at, text)
  return at
}

const text = (at: string): Promise<string> => readFile(at, 'utf8')

describe('one key of a JSON or JSONC file', () => {
  it('sets a nested key and keeps comments and the other keys', async () => {
    const at = await file(
      'opencode.jsonc',
      '{\n  // my provider\n  "provider": { "a": 1 },\n  "compaction": { "auto": true, },\n}\n',
    )
    expect(await setConfigValue(at, 'json', ['compaction', 'buffer'], 16000)).toBe(true)
    const written = await text(at)
    expect(written).toContain('// my provider')
    expect(written).toContain('"auto": true')
    expect(await readConfig(at, 'json')).toEqual({
      provider: { a: 1 },
      compaction: { auto: true, buffer: 16000 },
    })
  })

  it('removes the key and the objects it leaves empty, and nothing else', async () => {
    const at = await file(
      'settings.json',
      JSON.stringify({ theme: 'x', model: { compressionThreshold: 0.5 } }),
    )
    expect(await setConfigValue(at, 'json', ['model', 'compressionThreshold'], undefined)).toBe(
      true,
    )
    expect(await readConfig(at, 'json')).toEqual({ theme: 'x' })
    expect(await setConfigValue(at, 'json', ['model', 'compressionThreshold'], undefined)).toBe(
      false,
    )
  })

  it('keys a segment that holds a slash as one key', async () => {
    const at = await file('settings.json')
    const key = ['compaction', 'modelOverrides', 'openai/gpt-6', 'reserveTokens']
    await setConfigValue(at, 'json', key, 32000)
    expect(await readConfig(at, 'json')).toEqual({
      compaction: { modelOverrides: { 'openai/gpt-6': { reserveTokens: 32000 } } },
    })
  })

  it('writes nothing into a file it cannot read, or where a table is no object', async () => {
    const broken = await file('broken.json', '{ "a": ')
    await expect(setConfigValue(broken, 'json', ['b'], 1)).rejects.toThrow(/not valid JSON/)
    expect(await text(broken)).toBe('{ "a": ')
    const odd = await file('odd.json', '{ "compaction": 5 }')
    await expect(setConfigValue(odd, 'json', ['compaction', 'buffer'], 1)).rejects.toThrow(
      /not a table/,
    )
    expect(await text(odd)).toBe('{ "compaction": 5 }')
  })
})

describe('one key of a YAML file', () => {
  it('sets and removes a key, keeping comments', async () => {
    const at = await file('config.yaml', '# goose\nGOOSE_PROVIDER: openai # mine\n')
    await setConfigValue(at, 'yaml', ['GOOSE_AUTO_COMPACT_THRESHOLD'], 0.7)
    expect(await text(at)).toContain('# mine')
    expect(await readConfig(at, 'yaml')).toEqual({
      GOOSE_PROVIDER: 'openai',
      GOOSE_AUTO_COMPACT_THRESHOLD: 0.7,
    })
    await setConfigValue(at, 'yaml', ['GOOSE_AUTO_COMPACT_THRESHOLD'], undefined)
    expect(await text(at)).toBe('# goose\nGOOSE_PROVIDER: openai # mine\n')
  })

  it('creates the file with the nested key when it is absent', async () => {
    const at = await file('config.yml')
    await setConfigValue(at, 'yaml', ['compaction', 'thresholdTokens'], 272000)
    expect(await readConfig(at, 'yaml')).toEqual({ compaction: { thresholdTokens: 272000 } })
  })

  it('writes nothing into a file it cannot read', async () => {
    const at = await file('config.yaml', 'a: [1\n')
    await expect(setConfigValue(at, 'yaml', ['b'], 1)).rejects.toThrow(/not valid YAML/)
  })
})

describe('one key of a TOML file', () => {
  it('sets a key in an existing table and keeps comments and large integers', async () => {
    const at = await file(
      'config.toml',
      '# kimi\nmodel = "k2" # mine\nbig = 9007199254740993\n\n[loop_control]\nmax_steps = 5\n',
    )
    await setConfigValue(at, 'toml', ['loop_control', 'compaction_trigger_ratio'], 0.85)
    const written = await text(at)
    expect(written).toContain('# mine')
    expect(written).toContain('big = 9007199254740993')
    expect(written).toContain('compaction_trigger_ratio = 0.85')
  })

  it('removes the key with the table it leaves empty', async () => {
    const at = await file(
      'config.toml',
      'model = "k2"\n\n[session]\nauto_compact_threshold_percent = 80\n',
    )
    await setConfigValue(at, 'toml', ['session', 'auto_compact_threshold_percent'], undefined)
    expect(await readConfig(at, 'toml')).toEqual({ model: 'k2' })
  })

  it('creates the file when it is absent', async () => {
    const at = await file('vtcode.toml')
    await setConfigValue(
      at,
      'toml',
      ['agent', 'harness', 'auto_compaction_threshold_tokens'],
      272000,
    )
    expect(await readConfig(at, 'toml')).toEqual({
      agent: { harness: { auto_compaction_threshold_tokens: 272000 } },
    })
  })

  it('writes nothing into a file it cannot read', async () => {
    const at = await file('config.toml', 'a = \n')
    await expect(setConfigValue(at, 'toml', ['b'], 1)).rejects.toThrow(/not valid TOML/)
    expect(await text(at)).toBe('a = \n')
  })
})
