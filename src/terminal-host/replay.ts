import { TERMINAL_FLOW } from '@shared/terminal-host'

const COMPACT_AFTER = 512
// How far into a trimmed replay to look for a line start, so it does not open mid-sequence.
const LINE_START_SEARCH = 4096

/** The last `limit` bytes (UTF-8) of a terminal's output, to refill a screen after a reload. */
export class ReplayBuffer {
  private chunks: string[] = []
  private bytes = 0
  private startsAtLine = true // false once trimming cut into the middle of a line

  constructor(private readonly limit: number = TERMINAL_FLOW.replayBytes) {}

  get size(): number {
    return this.bytes
  }

  append(data: string): void {
    if (data.length === 0) return
    this.chunks.push(data)
    this.bytes += Buffer.byteLength(data)
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.bytes -= Buffer.byteLength(dropped)
      this.startsAtLine = dropped.endsWith('\n')
    }
    if (this.bytes > this.limit) {
      const { text, startsAtLine } = tailBytes(this.chunks[0], this.limit)
      this.chunks = [text]
      this.bytes = Buffer.byteLength(text)
      this.startsAtLine = startsAtLine
    }
    if (this.chunks.length > COMPACT_AFTER) this.chunks = [this.chunks.join('')]
  }

  snapshot(): string {
    const text = this.chunks.join('')
    if (this.startsAtLine) return text
    const newline = text.indexOf('\n')
    return newline >= 0 && newline < LINE_START_SEARCH ? text.slice(newline + 1) : text
  }
}

/** The last `limit` bytes of `text`, cut at a character boundary. */
function tailBytes(text: string, limit: number): { text: string; startsAtLine: boolean } {
  const bytes = Buffer.from(text)
  let start = bytes.length - limit
  // Skip UTF-8 continuation bytes so the cut lands on the first byte of a character.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return { text: bytes.subarray(start).toString(), startsAtLine: bytes[start - 1] === 0x0a }
}
