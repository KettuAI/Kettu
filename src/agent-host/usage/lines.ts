// Reading the complete lines a log gained since its cursor, from a plain file or a zstd one.
// A last line without its newline is left for the next scan, since the agent may still be
// writing it.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import type { FileCursor } from './model'

/** The bytes before a cursor's offset that must still match for the file to count as appended. */
export const TAIL_BYTES = 4096
const NEWLINE = 0x0a
/** How far a zstd log may inflate; a larger one is left unread, as a damaged one is. */
export const MAX_INFLATED = 2 ** 30
/** The inflated chunk size: the line loop yields to the worker's requests between chunks. */
const ZSTD_CHUNK = 1 << 18

/** A log's bytes: a plain file read in place, or a compressed one inflated as it is read. */
export interface ByteSource {
  /** The byte count; null for a zstd log until it has been inflated to its end. */
  readonly length: number | null
  /** Up to `length` bytes from `position`, fewer past the end. */
  read(position: number, length: number): Promise<Buffer>
  chunks(start: number, signal?: AbortSignal): AsyncIterable<Buffer>
}

export function fileSource(path: string, length: number): ByteSource {
  return {
    length,
    async read(position, size) {
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(size)
        const { bytesRead } = await handle.read(buffer, 0, size, position)
        return buffer.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    },
    chunks(start, signal) {
      if (start >= length) return emptyChunks()
      // `end` is inclusive; bytes appended after `stat` are left for the next scan.
      return createReadStream(path, { start, end: length - 1, highWaterMark: 1 << 20, signal })
    },
  }
}

export function bufferSource(buffer: Buffer): ByteSource {
  return {
    length: buffer.length,
    read: (position, size) => Promise.resolve(buffer.subarray(position, position + size)),
    async *chunks(start) {
      if (start < buffer.length) yield buffer.subarray(start)
    },
  }
}

async function* emptyChunks(): AsyncIterable<Buffer> {}

/**
 * A zstd log, inflated from its start at each pass and never held whole. The last two chunks of
 * the latest pass are kept, so the tail hash and a last line after a read need no other pass.
 */
export function zstdSource(path: string, limit = MAX_INFLATED): ByteSource {
  let length: number | null = null
  let kept: { at: number; chunk: Buffer }[] = []

  async function* inflate(signal?: AbortSignal): AsyncGenerator<{ at: number; chunk: Buffer }> {
    const input = createReadStream(path, signal ? { signal } : {})
    // Errors reach the loop below through the output stream.
    const output = pipeline(input, createZstdDecompress({ chunkSize: ZSTD_CHUNK }), () => {})
    let at = 0
    kept = []
    try {
      for await (const chunk of output as AsyncIterable<Buffer>) {
        if (at + chunk.length > limit) throw new Error(`it inflates to more than ${limit} bytes`)
        kept = [...kept.slice(-1), { at, chunk }]
        yield { at, chunk }
        at += chunk.length
      }
      length = at
    } finally {
      output.destroy()
    }
  }

  const fromKept = (position: number, end: number): Buffer | null => {
    const first = kept[0]
    const last = kept.at(-1)
    if (!first || !last) return null
    const keptEnd = last.at + last.chunk.length
    const stop = length === keptEnd ? Math.min(end, keptEnd) : end
    if (position < first.at || stop > keptEnd) return null
    return Buffer.concat(
      kept.map(({ at, chunk }) =>
        chunk.subarray(Math.max(position - at, 0), Math.max(Math.min(stop - at, chunk.length), 0)),
      ),
    )
  }

  return {
    get length() {
      return length
    },
    async read(position, size) {
      const end = position + size
      const ready = fromKept(position, end)
      if (ready) return ready
      const parts: Buffer[] = []
      for await (const { at, chunk } of inflate()) {
        const from = Math.max(position - at, 0)
        const to = Math.min(end - at, chunk.length)
        if (to > from) parts.push(chunk.subarray(from, to))
        if (at + chunk.length >= end) break
      }
      return Buffer.concat(parts)
    },
    async *chunks(start, signal) {
      for await (const { at, chunk } of inflate(signal)) {
        if (at + chunk.length <= start) continue
        yield at >= start ? chunk : chunk.subarray(start - at)
      }
    },
  }
}

export interface OpenedLog {
  source: ByteSource
  size: number
  mtimeNs: bigint
}

/** Opens a log for reading; a `.zst` file is inflated as it is read, and its size is the compressed one. */
export async function openLog(path: string): Promise<OpenedLog> {
  const info = await stat(path, { bigint: true })
  const size = Number(info.size)
  const source = path.endsWith('.zst') ? zstdSource(path) : fileSource(path, size)
  return { source, size, mtimeNs: info.mtimeNs }
}

/** Whether the file is exactly as its cursor saw it; time alone misses an append in one tick. */
export function unchanged(cursor: FileCursor | null, size: number, mtimeNs: bigint): boolean {
  return cursor !== null && cursor.size === size && cursor.mtimeNs === mtimeNs
}

/** 32 bits of a hash of the `TAIL_BYTES` before `offset`; null at the start of the file. */
export async function tailHash(source: ByteSource, offset: number): Promise<number | null> {
  return (await tailBytes(source, offset))?.hash ?? null
}

async function tailBytes(
  source: ByteSource,
  offset: number,
): Promise<{ hash: number; whole: boolean } | null> {
  if (offset <= 0) return null
  const start = Math.max(0, offset - TAIL_BYTES)
  const bytes = await source.read(start, offset - start)
  const hash = createHash('sha1').update(bytes).digest().readUInt32BE(0)
  return { hash, whole: bytes.length === offset - start }
}

/**
 * Where reading resumes: the cursor's offset while the bytes before it are unchanged, else 0,
 * since a shorter file or a different tail means it was rewritten.
 */
export async function resumeOffset(
  source: ByteSource,
  cursor: Pick<FileCursor, 'offset' | 'tail'> | null,
): Promise<number> {
  if (!cursor || cursor.offset <= 0) return 0
  if (source.length !== null && cursor.offset > source.length) return 0
  const tail = await tailBytes(source, cursor.offset)
  return tail?.whole && tail.hash === cursor.tail ? cursor.offset : 0
}

export interface EachLineOptions {
  /** Only lines holding these bytes are decoded and passed on; the rest are skipped unread. */
  contains?: string
  signal?: AbortSignal
}

/**
 * Calls `line` with every complete line from `start`, without its newline, and the offset just
 * past it. Resolves with the offset after the last complete line.
 */
export async function eachLine(
  source: ByteSource,
  start: number,
  line: (text: string, end: number) => void,
  options: EachLineOptions = {},
): Promise<number> {
  const needle = options.contains ? Buffer.from(options.contains) : null
  let carry: Buffer | null = null
  // The file offset of carry's first byte, or of the next chunk when there is no carry.
  let base = start
  let offset = start
  for await (const chunk of source.chunks(start, options.signal)) {
    options.signal?.throwIfAborted()
    const buffer: Buffer = carry ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer)
    let from = 0
    for (;;) {
      const newline = buffer.indexOf(NEWLINE, from)
      if (newline < 0) break
      const end = base + newline + 1
      const slice = buffer.subarray(from, newline)
      if (slice.length > 0 && (!needle || slice.indexOf(needle) >= 0)) {
        line(slice.toString('utf8').replace(/\r$/, ''), end)
      }
      offset = end
      from = newline + 1
    }
    carry = from < buffer.length ? Buffer.from(buffer.subarray(from)) : null
    base += from
  }
  return offset
}
