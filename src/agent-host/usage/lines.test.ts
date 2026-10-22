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
  zstdSource,
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
    const compressed = zstdCompressSync(Buffer.from('one\ntwo\n'))
    writeFileSync(file, compressed)
    const log = await openLog(file)
    expect(log.size).toBe(compressed.length)
    expect((await log.source.read(0, 3)).toString()).toBe('one')
    const lines: string[] = []
    await eachLine(log.source, 0, (text) => lines.push(text))
    expect(lines).toEqual(['one', 'two'])
    expect(log.source.length).toBe(8)
    // The tail comes from the last pass alone.
    expect(await tailHash(log.source, 8)).toBe(
      await tailHash(bufferSource(Buffer.from('one\ntwo\n')), 8),
    )
  })
})

describe('zstd logs', () => {
  /** A compressed log of `count` numbered lines, and its inflated bytes. */
  function zstdLog(name: string, count: number) {
    const text = Array.from({ length: count }, (_, i) => `line ${i} ${'x'.repeat(80)}`).join('\n')
    const plain = Buffer.from(`${text}\n`)
    const file = path.join(dir, name)
    writeFileSync(file, zstdCompressSync(plain))
    return { file, plain }
  }

  it('inflates as it reads, a chunk at a time, and learns the length at the end', async () => {
    const { file, plain } = zstdLog('big.jsonl.zst', 20_000)
    const { source } = await openLog(file)
    expect(source.length).toBeNull()
    let chunks = 0
    for await (const chunk of source.chunks(0)) chunks += chunk.length > 0 ? 1 : 0
    expect(chunks).toBeGreaterThan(2)
    expect(source.length).toBe(plain.length)
    const lines: string[] = []
    const end = await eachLine(source, 0, (text) => lines.push(text))
    expect(end).toBe(plain.length)
    expect(lines).toHaveLength(20_000)
    expect(lines.at(-1)).toBe(`line 19999 ${'x'.repeat(80)}`)
  })

  it('resumes from a cursor written while the log was plain', async () => {
    const { file, plain } = zstdLog('moved.jsonl.zst', 5_000)
    const offset = plain.lastIndexOf('\n', plain.length - 2) + 1
    const tail = await tailHash(bufferSource(plain), offset)
    const { source } = await openLog(file)
    expect(await resumeOffset(source, { offset, tail })).toBe(offset)
    const lines: string[] = []
    expect(await eachLine(source, offset, (text) => lines.push(text))).toBe(plain.length)
    expect(lines).toEqual([`line 4999 ${'x'.repeat(80)}`])
    expect(await tailHash(source, plain.length)).toBe(
      await tailHash(bufferSource(plain), plain.length),
    )
    expect(await resumeOffset(source, { offset: plain.length + 10, tail })).toBe(0)
  })

  it('stops at the size limit and when aborted', async () => {
    const { file } = zstdLog('bomb.jsonl.zst', 1_000)
    await expect(eachLine(zstdSource(file, 10_000), 0, () => {})).rejects.toThrow(
      'inflates to more than 10000 bytes',
    )
    const controller = new AbortController()
    controller.abort()
    await expect(
      eachLine(zstdSource(file), 0, () => {}, { signal: controller.signal }),
    ).rejects.toThrow()
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
