// Byte streams the host sends a device: the binary values of the agent host's results and the
// media files it reads. Each goes a frame at a time, so the channel's JSON slips in between, and
// waits while the transport holds more than a little, so a device that stops reading stops it.

import type { FileHandle } from 'node:fs/promises'
import type { PortError } from '@shared/port-rpc'
import { BYTES_PER_FRAME, type Channel } from '@shared/remote/channel'
import type { StreamCancel, StreamEnd } from '@shared/remote/streams'
import type { Transport } from '@shared/remote/transport'

/** What the transport may hold before a stream waits for it to drain. */
export const HIGH_WATER = 256 * 1024

export interface DownloadSource {
  readonly size: number
  /** `length` bytes from `offset`; fewer only when a file ends early. */
  read(offset: number, length: number): Promise<Uint8Array>
  close(): Promise<void>
}

/** Bytes already in memory, as a result holds them. */
export function bytesSource(data: Uint8Array): DownloadSource {
  return {
    size: data.length,
    read: async (offset, length) => data.subarray(offset, offset + length),
    close: async () => {},
  }
}

/** `length` bytes of an open file from `start`, read as they go; the file closes with it. */
export function fileSource(handle: FileHandle, start: number, length: number): DownloadSource {
  return {
    size: length,
    read: async (offset, count) => {
      const buffer = Buffer.allocUnsafe(count)
      let filled = 0
      while (filled < count) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          count - filled,
          start + offset + filled,
        )
        if (bytesRead === 0) break
        filled += bytesRead
      }
      return buffer.subarray(0, filled)
    },
    close: () => handle.close(),
  }
}

interface Download {
  stream: number
  source: DownloadSource
  started: boolean
  over: boolean
  /** Settles when the download is cancelled, so a wait for the transport ends with it. */
  cancelled: Promise<void>
  cancel(): void
  finish(): void
}

export interface DownloadsOptions {
  channel: Pick<Channel, 'send'>
  transport: Pick<Transport, 'buffered' | 'drained'>
  /** Sends a JSON message on the connection, in order with everything else. */
  send(message: StreamEnd | StreamCancel): void
  /** The host gave a download up, for the log; `reason` never names the file. */
  failed(reason: string): void
  highWater?: number
}

/** A file that is shorter than when it was opened. */
class EndedEarly extends Error {}

/** What went wrong, as a system error's code or an error's name, which hold no path. */
function errorCode(error: unknown): string {
  return (
    (error as NodeJS.ErrnoException | undefined)?.code ??
    (error as Error | undefined)?.name ??
    'unknown'
  )
}

/** One connection's downloads; the host's stream ids are even, from 2 up. */
export class Downloads {
  private readonly downloads = new Map<number, Download>()
  private next = 2
  private readonly highWater: number

  constructor(private readonly options: DownloadsOptions) {
    this.highWater = options.highWater ?? HIGH_WATER
  }

  /**
   * A stream for `source`, which sends nothing until `start`, so the message that names it goes
   * first; `finished` settles once it is over, sent, cancelled or failed.
   */
  open(source: DownloadSource): { stream: number; finished: Promise<void> } {
    const stream = this.next
    this.next += 2
    let cancel!: () => void
    const cancelled = new Promise<void>((resolve) => (cancel = resolve))
    let finish!: () => void
    const finished = new Promise<void>((resolve) => (finish = resolve))
    this.downloads.set(stream, {
      stream,
      source,
      started: false,
      over: false,
      cancelled,
      cancel,
      finish,
    })
    return { stream, finished }
  }

  start(stream: number): void {
    const download = this.downloads.get(stream)
    if (!download || download.started || download.over) return
    download.started = true
    void this.pump(download)
  }

  /** The device no longer wants a stream; bytes already on their way still reach it. */
  cancel(stream: number): void {
    const download = this.downloads.get(stream)
    if (!download || download.over) return
    download.over = true
    download.cancel()
    // One never started has no pump to close its source.
    if (!download.started) void this.settle(download)
  }

  /** The connection ended: every stream stops, saying nothing more. */
  closeAll(): void {
    for (const stream of [...this.downloads.keys()]) this.cancel(stream)
  }

  private async pump(download: Download): Promise<void> {
    const { stream, source } = download
    const { channel, transport } = this.options
    try {
      let sent = 0
      while (sent < source.size) {
        if (transport.buffered() > this.highWater) {
          await Promise.race([transport.drained(), download.cancelled])
        }
        if (download.over) return
        const want = Math.min(BYTES_PER_FRAME, source.size - sent)
        const data = await source.read(sent, want)
        if (download.over) return
        if (data.length < want) throw new EndedEarly()
        await channel.send({ kind: 'bytes', stream, data })
        sent += data.length
      }
      if (!download.over) this.options.send({ type: 'stream.end', stream })
    } catch (error) {
      if (download.over) return
      const ended = error instanceof EndedEarly
      // Never the error's own message, which may name the file.
      const message = ended
        ? `The file ended before its ${source.size} bytes`
        : 'The bytes could not be read'
      const failed: PortError = { code: 'internal', message }
      this.options.send({ type: 'stream.cancel', stream, error: failed })
      this.options.failed(ended ? message : `${message} (${errorCode(error)})`)
    } finally {
      download.over = true
      await this.settle(download)
    }
  }

  /** Ends a download's turn before its source closes, so its place is free at once. */
  private async settle(download: Download): Promise<void> {
    this.downloads.delete(download.stream)
    download.finish()
    await download.source.close().catch(() => {})
  }
}
