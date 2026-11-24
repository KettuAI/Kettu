import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigOption, HarnessId } from '@shared/thread'
import type { CodexRequest } from '../codex/rpc'
import { checkAutoCompact, readAutoCompact, writeAutoCompact, type CompactPlace } from './settings'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-auto-compact-'))
})

afterEach(() => rm(dir, { recursive: true, force: true }))

function place(harness: HarnessId, name: string, extra: Partial<CompactPlace> = {}): CompactPlace {
  return { harness, file: path.join(dir, name), version: null, config: undefined, ...extra }
}

const piModels: ConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value: 'openai/gpt-6',
    choices: [
      { value: 'openai/gpt-6', name: 'openai/GPT-6' },
      { value: 'anthropic/claude-opus-5-5', name: 'anthropic/Opus 5.5' },
    ],
  },
]

describe("an agent's auto-compact setting", () => {
  it('holds a percent as the fraction a harness takes, and reads it back as a percent', async () => {
    const gemini = place('gemini', 'settings.json')
    await writeAutoCompact(gemini, { model: null, value: 70 })
    expect(JSON.parse(await readFile(gemini.file, 'utf8'))).toEqual({
      model: { compressionThreshold: 0.7 },
    })
    expect(await readAutoCompact(gemini)).toMatchObject({ unit: 'percent', all: 70, models: null })
    await writeAutoCompact(gemini, { model: null, value: null })
    expect(JSON.parse(await readFile(gemini.file, 'utf8'))).toEqual({})
  })

  it('writes a whole percent for a harness that keeps one', async () => {
    const grok = place('grok', 'config.toml')
    await writeAutoCompact(grok, { model: null, value: 80 })
    expect(await readFile(grok.file, 'utf8')).toContain('auto_compact_threshold_percent = 80')
  })

  it("shows a value OpenCode's file holds as text as written", async () => {
    const opencode = place('opencode', 'opencode.json')
    await writeFile(opencode.file, '{ "compaction": { "buffer": "15%" } }')
    expect(await readAutoCompact(opencode)).toMatchObject({
      unit: 'reserve',
      all: null,
      allOther: '15%',
    })
  })

  it("lists Pi's models from 0.86.0 on, by the option value its overrides key them by", async () => {
    const old = place('pi', 'settings.json', { version: '0.85.0', config: piModels })
    expect((await readAutoCompact(old)).models).toBeNull()
    expect(() =>
      checkAutoCompact('pi', '0.85.0', { model: 'openai/gpt-6', value: 32000 }),
    ).toThrow()

    const pi = place('pi', 'settings.json', { version: '0.86.0', config: piModels })
    await writeAutoCompact(pi, { model: 'openai/gpt-6', value: 32000 })
    await writeAutoCompact(pi, { model: 'local/small', value: 8000 })
    expect(JSON.parse(await readFile(pi.file, 'utf8'))).toEqual({
      compaction: {
        modelOverrides: {
          'openai/gpt-6': { reserveTokens: 32000 },
          'local/small': { reserveTokens: 8000 },
        },
      },
    })
    expect((await readAutoCompact(pi)).models).toEqual([
      { model: 'openai/gpt-6', name: 'openai/GPT-6', value: 32000, other: null },
      { model: 'anthropic/claude-opus-5-5', name: 'anthropic/Opus 5.5', value: null, other: null },
      { model: 'local/small', name: null, value: 8000, other: null },
    ])
  })

  it("keeps DeepSeek Harness's threshold in its compaction row, and the row's other keys", async () => {
    const dsh = place('deepseek', 'cordis.patch.yml')
    await writeFile(
      dsh.file,
      '# mine\n- id: llm-pi-ai\n  config:\n    providers: {}\n- id: compaction-basic\n  config:\n    headroomTokens: 4096\n',
    )
    await writeAutoCompact(dsh, { model: null, value: 70 })
    const written = await readFile(dsh.file, 'utf8')
    expect(written).toContain('# mine')
    expect(written).toContain('headroomTokens: 4096')
    expect(written).toContain('thresholdRatio: 0.7')
    expect(await readAutoCompact(dsh)).toMatchObject({ all: 70 })
    await writeAutoCompact(dsh, { model: null, value: null })
    expect(await readFile(dsh.file, 'utf8')).not.toContain('thresholdRatio')
    expect(await readFile(dsh.file, 'utf8')).toContain('headroomTokens: 4096')
  })

  it('adds the compaction row to a patch without one, and drops it once it holds only its id', async () => {
    const dsh = place('deepseek', 'cordis.patch.yml')
    await writeAutoCompact(dsh, { model: null, value: 60 })
    expect(await readFile(dsh.file, 'utf8')).toBe(
      '- id: compaction-basic\n  config:\n    thresholdRatio: 0.6\n',
    )
    await writeAutoCompact(dsh, { model: null, value: null })
    expect((await readFile(dsh.file, 'utf8')).trim()).toBe('[]')
  })

  it("writes Codex's limit through its own config requests", async () => {
    const calls: [string, unknown][] = []
    const request = (async (method: string, params?: unknown) => {
      calls.push([method, params])
      return method === 'config/read' ? { config: { model_auto_compact_token_limit: 272000 } } : {}
    }) as CodexRequest
    const codex = place('codex', '', { codex: async () => request })
    expect(await readAutoCompact(codex)).toMatchObject({ unit: 'trigger', all: 272000, file: null })
    await writeAutoCompact(codex, { model: null, value: null })
    expect(calls.at(-1)).toEqual([
      'config/value/write',
      { keyPath: 'model_auto_compact_token_limit', value: null, mergeStrategy: 'replace' },
    ])
  })

  it('takes only a whole number in the harness range, and a model only where it keeps one', () => {
    expect(
      checkAutoCompact('claude-code', null, { model: ' claude-opus-5-5 ', value: 272000 }),
    ).toEqual({ model: 'claude-opus-5-5', value: 272000 })
    expect(() => checkAutoCompact('claude-code', null, { model: null, value: 50_000 })).toThrow()
    expect(() => checkAutoCompact('kimi', null, { model: null, value: 40 })).toThrow()
    expect(() => checkAutoCompact('gemini', null, { model: null, value: 85.5 })).toThrow()
    expect(() => checkAutoCompact('codex', null, { model: 'gpt-6', value: 272000 })).toThrow()
    expect(() => checkAutoCompact('cline', null, { model: null, value: 272000 })).toThrow()
    expect(() => checkAutoCompact('claude-code', null, { model: 'a b', value: 272000 })).toThrow()
  })
})
