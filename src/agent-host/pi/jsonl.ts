// Strict JSONL over a process's stdio: one JSON value per record, each ended by LF. Records are
// split on LF alone, never by a generic line reader: U+2028 and U+2029 are valid inside JSON
// strings, and Node.js `readline` would cut a record at them.

import type { Readable, Writable } from 'node:stream'

/** A record longer than this is dropped, so a stream that never ends a line cannot fill memory. */
export const MAX_RECORD_BYTES = 256 * 1024 * 1024

const LF = 0x0a
const CR = 0x0d

export interface JsonLineHandlers {
  record(value: unknown): void
  /** A line that is no JSON, such as what a program prints before its protocol starts. */
  garbage(line: string): void
}

/**
 * Feeds the records of a byte stream to `handlers` as its chunks arrive, wherever a chunk cuts a
 * record or a character. Returns the function that takes each chunk.
 */
export function jsonLineReader(
  handlers: JsonLineHandlers,
  maxBytes = MAX_RECORD_BYTES,
): (chunk: Buffer) => void {
  let held: Buffer[] = []
  let heldBytes = 0
  /** The rest of an oversized record is skipped up to its LF. */
  let skipping = false
  const take = (line: Buffer): void => {
    const end = line.length > 0 && line[line.length - 1] === CR ? line.length - 1 : line.length
    if (end === 0) return
    const text = line.toString('utf8', 0, end)
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      handlers.garbage(text)
      return
    }
    handlers.record(value)
  }
  return (chunk) => {
    let start = 0
    for (;;) {
      const at = chunk.indexOf(LF, start)
      if (at === -1) break
      const piece = chunk.subarray(start, at)
      start = at + 1
      if (skipping) {
        skipping = false
        continue
      }
      const line = held.length > 0 ? Buffer.concat([...held, piece]) : piece
      held = []
      heldBytes = 0
      take(line)
    }
    if (start >= chunk.length || skipping) return
    const rest = chunk.subarray(start)
    if (heldBytes + rest.length > maxBytes) {
      held = []
      heldBytes = 0
      skipping = true
      handlers.garbage(`a record of more than ${maxBytes} bytes`)
      return
    }
    held.push(rest)
    heldBytes += rest.length
  }
}

export interface JsonLineWriter {
  /** Writes one record, after the ones before it; resolves once the stream took it. */
  write(record: unknown): Promise<void>
  /** Ends the stream once what was written went out, which asks the reader to finish. */
  end(): void
}

/** Writes records to a stream one after another, waiting for it to drain when it is full. */
export function jsonLineWriter(output: Writable): JsonLineWriter {
  let last: Promise<void> = Promise.resolve()
  let failure: Error | null = null
  // A write after the reader went rejects through `write`; the stream's own event has no taker.
  output.on('error', (error: Error) => {
    failure ??= error
  })
  const send = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (failure || output.destroyed || output.writableEnded) {
        reject(failure ?? new Error('The stream is closed'))
        return
      }
      const drained = output.write(line, (error) => {
        if (error) {
          failure ??= error
          reject(error)
        } else if (drained) resolve()
      })
      if (!drained) output.once('drain', resolve)
    })
  return {
    write(record) {
      const line = `${JSON.stringify(record)}\n`
      const sent = last.then(
        () => send(line),
        () => send(line),
      )
      last = sent.catch(() => {})
      return sent
    },
    end() {
      void last.then(() => {
        if (!output.destroyed && !output.writableEnded) output.end()
      })
    },
  }
}

/** Reads the records `input` carries until it ends; settles once it has ended or failed. */
export function readJsonLines(input: Readable, handlers: JsonLineHandlers): Promise<void> {
  const feed = jsonLineReader(handlers)
  return new Promise((resolve) => {
    input.on('data', (chunk: Buffer | string) => {
      feed(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
    })
    input.once('end', resolve)
    input.once('close', resolve)
    input.once('error', () => resolve())
  })
}
