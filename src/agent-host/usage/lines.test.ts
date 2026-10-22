import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bufferSource,
  eachLine,
  openLog,
  resumeOffset,
  tailHash,
  TAIL_BYTES,
  unchanged,
} from './lines'
import { normalizeModel } from './model'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'usage-lines-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function collect(file: string, start: number, contains?: string) {
  const { source } = await openLog(file)
  const lines: [string, number][] = []
  const offset = await eachLine(source, start, (text, end) => lines.push([text, end]), {
    ...(contains ? { contains } : {}),
  })
  return { lines, offset }
}

describe('eachLine', () => {
  it('passes complete lines and leaves a partial last line for later', async () => {
    const file = path.join(dir, 'a.jsonl')
    writeFileSync(file, 'one\ntwo\r\nthr')
    const { lines, offset } = await collect(file, 0)
    expect(lines).toEqual([
      ['one', 4],
      ['two', 9],
    ])
    expect(offset).toBe(9)
  })

  it('resumes from an offset and skips lines without the needle', async () => {
    const file = path.join(dir, 'b.jsonl')
    writeFileSync(file, 'a usage 1\nb\nc usage 2\n')
    const { lines, offset } = await collect(file, 10, 'usage')
    expect(lines).toEqual([['c usage 2', 22]])
    expect(offset).toBe(22)
  })

  it('joins a line split across chunks', async () => {
    const long = 'x'.repeat((1 << 20) + 17)
    const file = path.join(dir, 'c.jsonl')
    writeFileSync(file, `${long}\nend\n`)
    const { lines } = await collect(file, 0)
    expect(lines.map(([text, end]) => [text.length, end])).toEqual([
      [long.length, long.length + 1],
      [3, long.length + 5],
    ])
  })

  it('reads a zstd log inflated, with its compressed size', async () => {
    const file = path.join(dir, 'd.jsonl.zst')
    writeFileSync(file, zstdCompressSync(Buffer.from('one\ntwo\n')))
    const log = await openLog(file)
    expect(log.source.length).toBe(8)
    const lines: string[] = []
    await eachLine(log.source, 0, (text) => lines.push(text))
    expect(lines).toEqual(['one', 'two'])
  })
})

describe('resumeOffset', () => {
  it('resumes while the bytes before the offset are unchanged', async () => {
    const file = path.join(dir, 'e.jsonl')
    writeFileSync(file, 'one\ntwo\n')
    const first = await openLog(file)
    const tail = await tailHash(first.source, 8)
    appendFileSync(file, 'three\n')
    const second = await openLog(file)
    expect(await resumeOffset(second.source, { offset: 8, tail })).toBe(8)
    expect(
      unchanged(
        {
          id: file,
          agentId: 'claude-code',
          size: first.size,
          mtimeNs: first.mtimeNs,
          offset: 8,
          tail,
          state: null,
        },
        second.size,
        second.mtimeNs,
      ),
    ).toBe(false)
  })

  it('starts over when the file was rewritten or shortened', async () => {
    const source = bufferSource(Buffer.from('one\ntwo\n'))
    const tail = await tailHash(source, 8)
    expect(
      await resumeOffset(bufferSource(Buffer.from('ONE\ntwo\nmore\n')), { offset: 8, tail }),
    ).toBe(0)
    expect(await resumeOffset(bufferSource(Buffer.from('one\n')), { offset: 8, tail })).toBe(0)
    expect(await resumeOffset(source, null)).toBe(0)
  })

  it('hashes at most the last TAIL_BYTES', async () => {
    const head = Buffer.alloc(10, 'a')
    const rest = Buffer.alloc(TAIL_BYTES, 'b')
    expect(
      await tailHash(bufferSource(Buffer.concat([head, rest])), head.length + rest.length),
    ).toBe(await tailHash(bufferSource(rest), rest.length))
  })
})

describe('normalizeModel', () => {
  it('gives one name per model across agents', () => {
    expect(normalizeModel('claude-sonnet-5[1m]')).toBe('claude-sonnet-5')
    expect(normalizeModel('openai/GPT-5.6-sol')).toBe('gpt-5.6-sol')
    expect(normalizeModel('gpt-5.6-sol/high')).toBe('gpt-5.6-sol')
    expect(normalizeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(normalizeModel('OpenAI/GPT-6.1-SOL-2026-10-01')).toBe('gpt-6.1-sol')
    expect(normalizeModel('opencode-go/GLM-5.3')).toBe('glm-5.3')
    expect(normalizeModel(null)).toBe('')
  })
})
