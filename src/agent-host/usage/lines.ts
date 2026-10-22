// Reading the complete lines a log gained since its cursor, from a plain file or a zstd one.
// A last line without its newline is left for the next scan, since the agent may still be
// writing it.

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import type { FileCursor } from './model'

const unzstd = promisify(zstdDecompress)

/** The bytes before a cursor's offset that must still match for the file to count as appended. */
export const TAIL_BYTES = 4096
const NEWLINE = 0x0a

/** A log's bytes: a plain file read in place, or a compressed one inflated in memory. */
export interface ByteSource {
  readonly length: number
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

export interface OpenedLog {
  source: ByteSource
  size: number
  mtimeNs: bigint
}

/** Opens a log for reading; a `.zst` file is inflated, and its size is the compressed one. */
export async function openLog(path: string): Promise<OpenedLog> {
  const info = await stat(path, { bigint: true })
  const size = Number(info.size)
  if (!path.endsWith('.zst')) return { source: fileSource(path, size), size, mtimeNs: info.mtimeNs }
  const inflated = await unzstd(await readFile(path))
  return { source: bufferSource(inflated), size, mtimeNs: info.mtimeNs }
}

/** Whether the file is exactly as its cursor saw it; time alone misses an append in one tick. */
export function unchanged(cursor: FileCursor | null, size: number, mtimeNs: bigint): boolean {
  return cursor !== null && cursor.size === size && cursor.mtimeNs === mtimeNs
}

/** 32 bits of a hash of the `TAIL_BYTES` before `offset`; null at the start of the file. */
export async function tailHash(source: ByteSource, offset: number): Promise<number | null> {
  if (offset <= 0) return null
  const start = Math.max(0, offset - TAIL_BYTES)
  const bytes = await source.read(start, offset - start)
  return createHash('sha1').update(bytes).digest().readUInt32BE(0)
}

/**
 * Where reading resumes: the cursor's offset while the bytes before it are unchanged, else 0,
 * since a shorter file or a different tail means it was rewritten.
 */
export async function resumeOffset(
  source: ByteSource,
  cursor: Pick<FileCursor, 'offset' | 'tail'> | null,
): Promise<number> {
  if (!cursor || cursor.offset <= 0 || cursor.offset > source.length) return 0
  return (await tailHash(source, cursor.offset)) === cursor.tail ? cursor.offset : 0
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
