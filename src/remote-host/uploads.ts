// What a device uploads as byte streams, each assembled in a file of the remote host's upload
// folder until a request names it, read once and deleted. An upload the device cancels, one it
// leaves without bytes or unnamed for a minute, and every one of a connection that ends goes too.
// While the disk lags behind what a device sends, its connections stop reading.

import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { PortError } from '@shared/port-rpc'
import {
  isDeviceStream,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS,
  UPLOAD_IDLE_MS,
} from '@shared/remote/streams'
import type { Transport } from '@shared/remote/transport'

/** Bytes a device's uploads may hold, received and not yet written, before it is read no more. */
export const MAX_UNWRITTEN = 1024 * 1024

/** Empties the upload folder of what an earlier run left, and makes it when there is none. */
export async function clearUploads(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true })
  await mkdir(folder, { recursive: true, mode: 0o700 })
}

/** Uploads in flight per device, over all its connections, and their bytes not yet written. */
export class UploadCounts {
  private readonly counts = new Map<string, number>()
  private readonly unwrittenBytes = new Map<string, number>()
  /** The connections of each device that stopped reading until its writes are within the bound. */
  private readonly behind = new Map<string, Set<() => void>>()

  constructor(
    readonly max = MAX_UPLOADS,
    readonly maxUnwritten = MAX_UNWRITTEN,
  ) {}

  take(deviceId: string): boolean {
    const count = this.counts.get(deviceId) ?? 0
    if (count >= this.max) return false
    this.counts.set(deviceId, count + 1)
    return true
  }

  release(deviceId: string): void {
    const count = (this.counts.get(deviceId) ?? 0) - 1
    if (count > 0) this.counts.set(deviceId, count)
    else this.counts.delete(deviceId)
  }

  of(deviceId: string): number {
    return this.counts.get(deviceId) ?? 0
  }

  /** Bytes the device's uploads received; whether its writes now lag past the bound. */
  received(deviceId: string, bytes: number): boolean {
    const total = this.unwritten(deviceId) + bytes
    this.unwrittenBytes.set(deviceId, total)
    return total > this.maxUnwritten
  }

  /** Bytes received before are written, or gone with their upload. */
  written(deviceId: string, bytes: number): void {
    const total = this.unwritten(deviceId) - bytes
    if (total > 0) this.unwrittenBytes.set(deviceId, total)
    else this.unwrittenBytes.delete(deviceId)
    if (total > this.maxUnwritten) return
    const waiting = this.behind.get(deviceId)
    this.behind.delete(deviceId)
    for (const resume of waiting ?? []) resume()
  }

  unwritten(deviceId: string): number {
    return this.unwrittenBytes.get(deviceId) ?? 0
  }

  /**
   * Calls `resume` once the device's writes are back within the bound, which they are past now;
   * the function it returns stops waiting.
   */
  caughtUp(deviceId: string, resume: () => void): () => void {
    const waiting = this.behind.get(deviceId) ?? new Set<() => void>()
    this.behind.set(deviceId, waiting)
    waiting.add(resume)
    return () => {
      waiting.delete(resume)
      if (waiting.size === 0 && this.behind.get(deviceId) === waiting) this.behind.delete(deviceId)
    }
  }
}

/** Why an upload a request names cannot be used, as the request's error. */
export class UploadError extends Error {
  constructor(readonly error: PortError) {
    super(error.message)
  }
}

interface Upload {
  stream: number
  size: number
  received: number
  file: string
  /** Each step on the file after the one before, from its creation; null when it was not made. */
  writing: Promise<FileHandle | null>
  complete: boolean
  claimed: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** Settles once every byte is in the file, or rejects when the upload goes first. */
  done: Promise<void>
  settle: { resolve: () => void; reject: (error: UploadError) => void }
}

export interface UploadsOptions {
  folder: string
  deviceId: string
  counts: UploadCounts
  /** The connection's, which stops reading while the device's writes lag past the bound. */
  transport: Pick<Transport, 'pause' | 'resume'>
  /** The host gave an upload up, for the device to hear why. */
  cancelled(stream: number, error: PortError): void
  maxBytes?: number
  idleMs?: number
}

/** One connection's uploads. */
export class Uploads {
  private readonly uploads = new Map<number, Upload>()
  private last = 0
  private closed = false
  /** Stops waiting for the device's writes, while this connection reads nothing. */
  private behind: (() => void) | null = null
  private readonly maxBytes: number
  private readonly idleMs: number

  constructor(private readonly options: UploadsOptions) {
    this.maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES
    this.idleMs = options.idleMs ?? UPLOAD_IDLE_MS
  }

  /** Opens an upload; false when its id breaks the protocol, being even or not above the last. */
  open(stream: unknown, size: unknown): boolean {
    if (!isDeviceStream(stream) || stream <= this.last) return false
    this.last = stream
    if (this.closed) return true
    const { counts, deviceId } = this.options
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      this.refuse(stream, 'invalid_params', `Upload ${stream} has no size in bytes`)
    } else if (size > this.maxBytes) {
      this.refuse(stream, 'invalid_params', `An upload is at most ${this.maxBytes} bytes`)
    } else if (!counts.take(deviceId)) {
      this.refuse(stream, 'busy', `A device may have at most ${counts.max} uploads at once`)
    } else {
      this.start(stream, size)
    }
    return true
  }

  bytes(stream: number, data: Uint8Array): void {
    const upload = this.uploads.get(stream)
    // Bytes of an upload the host gave up may still be on their way.
    if (!upload || upload.complete) return
    upload.received += data.length
    if (upload.received > upload.size) {
      return this.fail(upload, `Upload ${stream} carried more than its ${upload.size} bytes`)
    }
    const { counts, deviceId } = this.options
    const lagging = counts.received(deviceId, data.length)
    this.queue(
      upload,
      (handle) => write(handle, data),
      () => counts.written(deviceId, data.length),
    )
    if (lagging) this.stopReading()
    this.watch(upload)
  }

  end(stream: number): void {
    const upload = this.uploads.get(stream)
    if (!upload || upload.complete) return
    if (upload.received !== upload.size) {
      const message = `Upload ${stream} ended after ${upload.received} of its ${upload.size} bytes`
      return this.fail(upload, message)
    }
    upload.complete = true
    this.queue(upload, async (handle) => {
      await handle.close()
      upload.settle.resolve()
    })
    this.watch(upload)
  }

  /** The device gives an upload up; one a request is reading already is past giving up. */
  cancel(stream: number): void {
    const upload = this.uploads.get(stream)
    if (!upload || (upload.claimed && upload.complete)) return
    this.drop(upload, { code: 'invalid_params', message: `Upload ${stream} was cancelled` })
  }

  /**
   * The bytes of the upload `stream`, which a request names, once they are all in; its file goes
   * once they are read. It is claimed at once, so no other request may name it.
   */
  async claim(stream: unknown): Promise<ArrayBuffer> {
    const upload = typeof stream === 'number' ? this.uploads.get(stream) : undefined
    if (!upload || upload.claimed) {
      const message = `Stream ${String(stream)} is no upload waiting on this connection`
      throw new UploadError({ code: 'invalid_params', message })
    }
    upload.claimed = true
    this.watch(upload)
    try {
      await upload.done
      const data = await readFile(upload.file)
      return data.buffer.byteLength === data.byteLength
        ? (data.buffer as ArrayBuffer)
        : new Uint8Array(data).buffer
    } catch (error) {
      if (error instanceof UploadError) throw error
      throw new UploadError({ code: 'internal', message: `Upload ${stream} could not be read` })
    } finally {
      this.drop(upload, null)
    }
  }

  /**
   * The connection dropped while its session stays: the uploads it had not finished go, as their
   * bytes on the way are lost, and the finished ones wait for the requests that name them.
   */
  dropUnfinished(): void {
    const error = { code: 'invalid_params' as const, message: 'The connection ended' }
    for (const upload of [...this.uploads.values()]) {
      if (!upload.complete) this.drop(upload, error)
    }
  }

  /** The connection ended: every upload goes. */
  closeAll(): void {
    this.closed = true
    this.behind?.()
    this.behind = null
    const error = { code: 'invalid_params' as const, message: 'The connection ended' }
    for (const upload of [...this.uploads.values()]) this.drop(upload, error)
  }

  private start(stream: number, size: number): void {
    const file = path.join(this.options.folder, `${randomBytes(16).toString('hex')}.part`)
    let settle!: Upload['settle']
    const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
    // An upload given up before a request names it has nobody to tell.
    done.catch(() => {})
    const upload: Upload = {
      stream,
      size,
      received: 0,
      file,
      writing: Promise.resolve(null),
      complete: false,
      claimed: false,
      timer: null,
      done,
      settle,
    }
    upload.writing = open(file, 'wx', 0o600).catch(() => {
      this.fail(upload, `Upload ${stream} could not be written`, 'internal')
      return null
    })
    this.uploads.set(stream, upload)
    this.watch(upload)
  }

  /**
   * Runs `step` on the upload's file after every step before it, while the upload is kept, then
   * `settled` whether it ran or not.
   */
  private queue(
    upload: Upload,
    step: (handle: FileHandle) => Promise<unknown>,
    settled?: () => void,
  ): void {
    upload.writing = upload.writing.then(async (handle) => {
      try {
        if (handle && this.uploads.get(upload.stream) === upload) await step(handle)
      } catch {
        this.fail(upload, `Upload ${upload.stream} could not be written`, 'internal')
      } finally {
        settled?.()
      }
      return handle
    })
  }

  /** The disk lags past the bound: the connection reads nothing until it is back within it. */
  private stopReading(): void {
    if (this.behind || this.closed) return
    const { transport, counts, deviceId } = this.options
    transport.pause()
    this.behind = counts.caughtUp(deviceId, () => {
      this.behind = null
      transport.resume()
    })
  }

  /** Restarts the minute an upload may wait for its next bytes or for a request to name it. */
  private watch(upload: Upload): void {
    if (upload.timer) clearTimeout(upload.timer)
    upload.timer = null
    if (upload.claimed && upload.complete) return
    upload.timer = setTimeout(() => {
      const waiting = upload.complete ? 'was not named by a request' : 'got no bytes'
      this.fail(upload, `Upload ${upload.stream} ${waiting} for ${this.idleMs / 1000} s`)
    }, this.idleMs)
  }

  private refuse(stream: number, code: PortError['code'], message: string): void {
    this.options.cancelled(stream, { code, message })
  }

  /** The host gives an upload up and tells the device why. */
  private fail(upload: Upload, message: string, code: PortError['code'] = 'invalid_params'): void {
    if (this.uploads.get(upload.stream) !== upload) return
    const error = { code, message }
    this.drop(upload, error)
    this.options.cancelled(upload.stream, error)
  }

  /** Forgets an upload and deletes its file; a request waiting for it fails with `error`. */
  private drop(upload: Upload, error: PortError | null): void {
    if (this.uploads.get(upload.stream) !== upload) return
    this.uploads.delete(upload.stream)
    this.options.counts.release(this.options.deviceId)
    if (upload.timer) clearTimeout(upload.timer)
    if (error) upload.settle.reject(new UploadError(error))
    const { file } = upload
    upload.writing = upload.writing
      .then((handle) => handle?.close())
      .catch(() => {})
      .then(() => rm(file, { force: true }))
      .then(
        () => null,
        () => null,
      )
  }
}

async function write(handle: FileHandle, data: Uint8Array): Promise<void> {
  let written = 0
  while (written < data.length) {
    const { bytesWritten } = await handle.write(data, written, data.length - written)
    written += bytesWritten
  }
}
