import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cacheTtlOfLine,
  claudeCacheTtl,
  claudeProjectFolder,
  findClaudeTranscript,
  readCacheTtl,
} from './prompt-cache'

const MINUTE = 60_000

/** A Claude Code transcript line of an API message, with its cache writes split by lifetime. */
function assistant(
  split: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    message: {
      id: 'msg_1',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 120,
        cache_read_input_tokens: 4_000,
        output_tokens: 30,
        ...(split ? { cache_creation: split } : {}),
      },
    },
    type: 'assistant',
    timestamp: '2026-10-23T06:48:47.714Z',
    sessionId: 'abc',
    ...extra,
  })
}

const oneHour = assistant({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 120 })
const fiveMinutes = assistant({ ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 0 })
const user = (text: string): string =>
  JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } })

let dir: string

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'kettu-cache-')))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function transcript(lines: string[], end = '\n'): Promise<string> {
  const file = path.join(dir, 'session.jsonl')
  await writeFile(file, lines.join('\n') + end)
  return file
}

describe('cacheTtlOfLine', () => {
  it('reads the lifetime of what a main-thread message wrote to the cache', () => {
    expect(cacheTtlOfLine(oneHour)).toBe(60 * MINUTE)
    expect(cacheTtlOfLine(fiveMinutes)).toBe(5 * MINUTE)
  })

  it('takes the shorter lifetime when a message wrote both', () => {
    expect(
      cacheTtlOfLine(assistant({ ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 110 })),
    ).toBe(5 * MINUTE)
  })

  it('says nothing for a line that wrote nothing, or did not say for how long', () => {
    expect(
      cacheTtlOfLine(assistant({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 })),
    ).toBeNull()
    expect(cacheTtlOfLine(assistant(null))).toBeNull()
    expect(cacheTtlOfLine(assistant({ ephemeral_5m_input_tokens: -3 }))).toBeNull()
    expect(cacheTtlOfLine(assistant({ ephemeral_1h_input_tokens: '120' as never }))).toBeNull()
  })

  it("leaves out subagents' messages and lines that are not messages", () => {
    expect(cacheTtlOfLine(assistant({ ephemeral_5m_input_tokens: 9 }, { isSidechain: true }))).toBe(
      null,
    )
    expect(cacheTtlOfLine(user('"ephemeral_5m_input_tokens": 120'))).toBeNull()
    expect(cacheTtlOfLine('{"type":"assistant","message":null}')).toBeNull()
  })

  it('ignores malformed lines', () => {
    expect(cacheTtlOfLine(oneHour.slice(0, -5))).toBeNull()
    expect(cacheTtlOfLine('not json "ephemeral_1h_input_tokens"')).toBeNull()
    expect(cacheTtlOfLine('null')).toBeNull()
    expect(cacheTtlOfLine('')).toBeNull()
  })
})

describe('readCacheTtl', () => {
  it('finds the latest message that wrote to the cache', async () => {
    expect(await readCacheTtl(await transcript([fiveMinutes, user('next'), oneHour]))).toBe(
      60 * MINUTE,
    )
    expect(await readCacheTtl(await transcript([oneHour, fiveMinutes, user('next')]))).toBe(
      5 * MINUTE,
    )
  })

  it('looks past messages that wrote nothing and past subagents', async () => {
    const lines = [
      oneHour,
      assistant({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }),
      assistant({ ephemeral_5m_input_tokens: 50 }, { isSidechain: true }),
      user('done'),
    ]
    expect(await readCacheTtl(await transcript(lines))).toBe(60 * MINUTE)
  })

  it('gives nothing for a transcript without cache lifetimes, or an empty one', async () => {
    expect(await readCacheTtl(await transcript([user('hi'), assistant(null)]))).toBeNull()
    expect(await readCacheTtl(await transcript([], ''))).toBeNull()
  })

  it('skips malformed lines and a last line still being written', async () => {
    const lines = [fiveMinutes, '{"type":"assistant", broken', '\u0000\u0001garbage']
    const file = await transcript([...lines, oneHour.slice(0, 40)], '')
    expect(await readCacheTtl(file)).toBe(5 * MINUTE)
  })

  it('joins lines that cross the chunks it reads', async () => {
    const file = await transcript([oneHour, user('x'.repeat(50)), fiveMinutes, user('y')])
    expect(await readCacheTtl(file, { chunk: 7 })).toBe(5 * MINUTE)
    expect(await readCacheTtl(file, { chunk: 1 })).toBe(5 * MINUTE)
  })

  it('reads only the end of a huge transcript', async () => {
    const filler = Array.from({ length: 20_000 }, (_, i) => user(`line ${i} ${'z'.repeat(400)}`))
    expect(await readCacheTtl(await transcript([...filler, oneHour]))).toBe(60 * MINUTE)
    // 8 MB after the last cache write: beyond the bound, so it is not found.
    expect(await readCacheTtl(await transcript([oneHour, ...filler]))).toBeNull()
    expect(await readCacheTtl(await transcript([oneHour, user('x')]), { limit: 64 })).toBeNull()
  })

  it('gives up on one line longer than it reads', async () => {
    const huge = user('w'.repeat(3 * 1024 * 1024))
    expect(await readCacheTtl(await transcript([oneHour, huge]))).toBeNull()
  })
})

describe('claudeProjectFolder', () => {
  it("names a project's folder as Claude Code does", () => {
    expect(claudeProjectFolder('/Users/me/DevProjects/kettu')).toBe('-Users-me-DevProjects-kettu')
    expect(claudeProjectFolder('/Users/me/项目 one')).toBe('-Users-me----one')
    expect(claudeProjectFolder('C:\\Users\\me\\proj')).toBe('C--Users-me-proj')
  })

  it('cuts a long name and adds a hash of the path', () => {
    const long = '/Users/me/' + 'very-long-folder-name/'.repeat(10) + 'project'
    const folder = claudeProjectFolder(long)
    expect(folder).toHaveLength(207)
    expect(folder.endsWith('-very-long-fold-5e0c82')).toBe(true)
  })
})

describe('findClaudeTranscript', () => {
  it("finds a session's transcript in its project's folder", async () => {
    const projects = path.join(dir, 'projects')
    const project = path.join(dir, 'work', 'app')
    await mkdir(project, { recursive: true })
    const folder = path.join(projects, claudeProjectFolder(project))
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 's1.jsonl'), oneHour + '\n')
    expect(await findClaudeTranscript(projects, project, 's1')).toBe(path.join(folder, 's1.jsonl'))

    const link = path.join(dir, 'link')
    await symlink(project, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await findClaudeTranscript(projects, link, 's1')).toBe(path.join(folder, 's1.jsonl'))
  })

  it('names the folder from the NFC form of the path, as Claude Code does on every platform', async () => {
    const projects = path.join(dir, 'projects')
    const project = path.join(dir, 'cafe\u0301')
    await mkdir(project)
    const real = await realpath(project)
    // Both folders hold the session, so only the direct path decides which one is found.
    const composed = path.join(projects, claudeProjectFolder(real.normalize('NFC')))
    const decomposed = path.join(projects, claudeProjectFolder(real.normalize('NFD')))
    expect(composed).not.toBe(decomposed)
    for (const folder of [composed, decomposed]) {
      await mkdir(folder, { recursive: true })
      await writeFile(path.join(folder, 's3.jsonl'), oneHour + '\n')
    }
    expect(await findClaudeTranscript(projects, project, 's3')).toBe(
      path.join(composed, 's3.jsonl'),
    )
  })

  it('looks in the other folders when the project folder has no such session', async () => {
    const projects = path.join(dir, 'projects')
    const elsewhere = path.join(projects, 'renamed-folder')
    await mkdir(elsewhere, { recursive: true })
    await mkdir(path.join(projects, 'other'), { recursive: true })
    await writeFile(path.join(elsewhere, 's2.jsonl'), oneHour + '\n')
    expect(await findClaudeTranscript(projects, path.join(dir, 'gone'), 's2')).toBe(
      path.join(elsewhere, 's2.jsonl'),
    )
    expect(await findClaudeTranscript(projects, dir, 'missing')).toBeNull()
    expect(await findClaudeTranscript(path.join(dir, 'none'), dir, 's2')).toBeNull()
  })

  it('never takes a session id as a path', async () => {
    const projects = path.join(dir, 'projects')
    await mkdir(path.join(projects, 'a'), { recursive: true })
    await writeFile(path.join(dir, 'secret.jsonl'), oneHour + '\n')
    expect(await findClaudeTranscript(projects, dir, '../../secret')).toBeNull()
  })
})

describe('claudeCacheTtl', () => {
  it("reads a Claude Code session's transcript under its configuration folder", async () => {
    const config = path.join(dir, 'config')
    const project = path.join(dir, 'app')
    await mkdir(project)
    const folder = path.join(config, 'projects', claudeProjectFolder(project))
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 's1.jsonl'), [fiveMinutes, oneHour].join('\n') + '\n')
    const read = claudeCacheTtl({
      platform: process.platform,
      home: path.join(dir, 'home'),
      env: async () => ({ CLAUDE_CONFIG_DIR: config }),
      log: () => {},
    })
    expect(await read('claude-code', project, 's1')).toBe(60 * MINUTE)
    expect(await read('codex', project, 's1')).toBeNull()
    expect(await read('claude-code', project, 'other')).toBeNull()
  })
})
