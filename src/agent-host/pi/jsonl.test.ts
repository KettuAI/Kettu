// JSONL framing over stdio: records are cut at LF alone, wherever a chunk falls.

import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { jsonLineReader, jsonLineWriter, readJsonLines } from './jsonl'

function reader(maxBytes?: number) {
  const records: unknown[] = []
  const garbage: string[] = []
  const feed = jsonLineReader(
    { record: (value) => records.push(value), garbage: (line) => garbage.push(line) },
    maxBytes,
  )
  return { records, garbage, feed: (text: string | Buffer) => feed(Buffer.from(text)) }
}

describe('reading JSON lines', () => {
  it('takes one record per line, with or without a carriage return', () => {
    const { records, feed } = reader()
    feed('{"a":1}\n{"b":2}\r\n\n{"c":3}\n')
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('joins a record that arrives in pieces, and waits for its line to end', () => {
    const { records, feed } = reader()
    feed('{"type":"mess')
    feed('age","te')
    expect(records).toEqual([])
    feed('xt":"hi"}\n{"next"')
    expect(records).toEqual([{ type: 'message', text: 'hi' }])
    feed(':true}\n')
    expect(records).toEqual([{ type: 'message', text: 'hi' }, { next: true }])
  })

  it('keeps a character whose bytes two chunks share', () => {
    const { records, feed } = reader()
    const bytes = Buffer.from('{"text":"狐狸"}\n')
    feed(bytes.subarray(0, 11))
    feed(bytes.subarray(11))
    expect(records).toEqual([{ text: '狐狸' }])
  })

  it('does not cut a record at a Unicode line or paragraph separator', () => {
    const { records, feed } = reader()
    feed(`${JSON.stringify({ text: 'a b c' })}\n`)
    // JSON.stringify leaves both as they are, which a generic line reader would split at.
    expect(records).toEqual([{ text: 'a b c' }])
  })

  it('hands on a line that is no JSON, and goes on', () => {
    const { records, garbage, feed } = reader()
    feed('Loading extensions...\n{"ok":true}\n')
    expect(garbage).toEqual(['Loading extensions...'])
    expect(records).toEqual([{ ok: true }])
  })

  it('drops a record that outgrows the limit, up to its end', () => {
    const { records, garbage, feed } = reader(16)
    feed('{"big":"0123456789')
    feed('0123456789')
    feed('0123456789"}\n{"ok":1}\n')
    expect(records).toEqual([{ ok: 1 }])
    expect(garbage).toHaveLength(1)
  })

  it('settles once the stream ends', async () => {
    const stream = new PassThrough()
    const records: unknown[] = []
    const done = readJsonLines(stream, {
      record: (value) => records.push(value),
      garbage: () => {},
    })
    stream.write('{"a":1}\n')
    stream.end()
    await done
    expect(records).toEqual([{ a: 1 }])
  })
})

describe('writing JSON lines', () => {
  it('writes each record on a line of its own, in order', async () => {
    const stream = new PassThrough()
    const written: Buffer[] = []
    stream.on('data', (chunk: Buffer) => written.push(chunk))
    const writer = jsonLineWriter(stream)
    await Promise.all([writer.write({ a: 'x\ny' }), writer.write({ b: 2 })])
    expect(Buffer.concat(written).toString()).toBe('{"a":"x\\ny"}\n{"b":2}\n')
  })

  it('waits for a full stream to drain before the next record', async () => {
    const taken: string[] = []
    let release: (() => void) | null = null
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        taken.push(chunk.toString())
        release = callback
      },
    })
    const writer = jsonLineWriter(slow)
    const first = writer.write({ n: 1 })
    const second = writer.write({ n: 2 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(taken).toEqual(['{"n":1}\n'])
    release!()
    await first
    await new Promise((resolve) => setImmediate(resolve))
    expect(taken).toEqual(['{"n":1}\n', '{"n":2}\n'])
    release!()
    await second
  })

  it('rejects a record written after the stream closed', async () => {
    const stream = new PassThrough()
    const writer = jsonLineWriter(stream)
    stream.destroy()
    await expect(writer.write({ late: true })).rejects.toThrow()
  })
})
