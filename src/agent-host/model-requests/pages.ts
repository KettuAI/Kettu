// Reads a session file a page at a time, back from a place in it, so a long session costs no more
// than a short one. What counts as a request and where a turn starts are the agent's own.

import type { ByteSource } from '../usage/lines'
import type { TranscriptLine } from './claude-transcript'

const CHUNK = 1 << 18
/** How far back a page goes for the start of its first turn. */
const TURN_LIMIT = 8 << 20
const NEWLINE = 0x0a

export interface RawLine {
  start: number
  end: number
  bytes: Buffer
}

/** One agent's reading of its lines, made afresh for each page since it counts as it goes. */
export interface PageRules {
  /** Takes a line read back from the end, newest first. */
  add(line: Buffer): void
  /** Whether the lines taken so far hold a page of requests. */
  enough(): boolean
  /** Whether a line starts a turn, where a full page begins. */
  turnStart(line: Buffer): boolean
  /** Whether a line ends a request, so a page may begin just after it. */
  requestEnd(line: Buffer): boolean
}

/**
 * The lines of a page ending at `end`: a page of requests, back to the start of the turn the
 * earliest of them is in when that lies within `TURN_LIMIT`, else back to just after the earliest
 * request's end read, so no request is cut. `from` is where the page starts.
 */
export async function readPageFrom(
  source: ByteSource,
  end: number,
  rules: PageRules,
): Promise<{ lines: RawLine[]; from: number }> {
  // Newest first while reading.
  const lines: RawLine[] = []
  const page = (from: number) => ({
    lines: lines.filter((line) => line.start >= from).reverse(),
    from,
  })
  let rest = Buffer.alloc(0)
  let at = end
  // Where enough requests were read, and the earliest place after a request's end since.
  let enoughAt: number | null = null
  let cut: number | null = null
  while (at > 0) {
    const start = Math.max(0, at - CHUNK)
    const chunk = await source.read(start, at - start)
    const data = Buffer.concat([chunk, rest])
    let stop = data.length
    for (;;) {
      const newline = data.lastIndexOf(NEWLINE, stop - 1)
      if (newline === -1 && start > 0) break
      const bytes = data.subarray(newline + 1, stop)
      const begin = start + newline + 1
      if (bytes.length > 0) {
        if (enoughAt !== null) {
          if (rules.turnStart(bytes)) {
            lines.push({ start: begin, end: begin + bytes.length, bytes })
            return page(begin)
          }
          if (rules.requestEnd(bytes)) cut = begin + bytes.length + 1
          if (enoughAt - begin > TURN_LIMIT && cut !== null) return page(cut)
        }
        lines.push({ start: begin, end: begin + bytes.length, bytes })
        rules.add(bytes)
        if (enoughAt === null && rules.enough()) enoughAt = begin
      }
      if (newline === -1) break
      stop = newline
    }
    rest = Buffer.from(data.subarray(0, stop))
    at = start
  }
  return page(0)
}

/** Whole JSON objects of some lines; a line cut by a write in progress is left out. */
export function parseLines(lines: RawLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = []
  for (const line of lines) {
    try {
      const record = JSON.parse(line.bytes.toString('utf8')) as unknown
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        out.push({ start: line.start, end: line.end, record: record as Record<string, unknown> })
      }
    } catch {
      // Read with the next page.
    }
  }
  return out
}
