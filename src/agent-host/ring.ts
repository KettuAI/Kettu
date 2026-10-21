// Bounded buffers, so no amount of agent output can grow the host's memory.

/** Keeps the most recent items, by count and by total size. */
export class Ring<T> {
  private items: { item: T; size: number }[] = []
  private head = 0
  private total = 0

  constructor(
    private readonly capacity: number,
    private readonly maxSize = Number.POSITIVE_INFINITY,
  ) {}

  push(item: T, size = 0): void {
    this.items.push({ item, size })
    this.total += size
    while (this.items.length - this.head > this.capacity || this.total > this.maxSize) {
      const dropped = this.items[this.head++]
      if (!dropped) break
      this.total -= dropped.size
    }
    // Compact once the dropped prefix dominates, so pushes stay amortized O(1).
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
  }

  toArray(): T[] {
    return this.items.slice(this.head).map((entry) => entry.item)
  }

  get length(): number {
    return this.items.length - this.head
  }

  get size(): number {
    return this.total
  }

  clear(): void {
    this.items = []
    this.head = 0
    this.total = 0
  }
}

/** The last `maxChars` characters of a text stream, such as an agent's stderr. */
export class TextRing {
  private chunks: string[] = []
  private length = 0

  constructor(private readonly maxChars: number) {}

  push(text: string): void {
    if (text === '') return
    if (text.length >= this.maxChars) {
      this.chunks = [text.slice(text.length - this.maxChars)]
      this.length = this.maxChars
      return
    }
    this.chunks.push(text)
    this.length += text.length
    while (this.length > this.maxChars) {
      const first = this.chunks[0]!
      const excess = this.length - this.maxChars
      if (first.length <= excess) {
        this.chunks.shift()
        this.length -= first.length
      } else {
        this.chunks[0] = first.slice(excess)
        this.length -= excess
      }
    }
  }

  toString(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join('')]
    return this.chunks[0] ?? ''
  }

  /** The last `count` non-empty lines, with CRLF and progress-bar carriage returns handled. */
  lastLines(count: number): string[] {
    const lines = this.toString()
      .split('\n')
      .map((line) => {
        const parts = line.replace(/\r$/, '').split('\r')
        return parts[parts.length - 1]!.trimEnd()
      })
      .filter((line) => line !== '')
    return lines.slice(-count)
  }

  clear(): void {
    this.chunks = []
    this.length = 0
  }
}
