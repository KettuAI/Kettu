// A device's uploads hold in memory only what the disk has not taken yet: past a bound, the
// device's connections stop reading until the writes are back within it.

import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MAX_UPLOADS } from '@shared/remote/streams'
import { tempFolder } from '../agent-host/testing/temp'
import { UploadCounts, Uploads } from './uploads'

/** A transport's reading, as an upload pauses and resumes it. */
function reading() {
  const transport = {
    paused: false,
    pauses: 0,
    pause: () => {
      transport.paused = true
      transport.pauses++
    },
    resume: () => {
      transport.paused = false
    },
  }
  return transport
}

async function connection(counts: UploadCounts, deviceId = 'phone') {
  const transport = reading()
  const folder = await tempFolder('kettu-uploads-')
  const uploads = new Uploads({
    folder,
    deviceId,
    counts,
    transport,
    cancelled: (stream, error) => {
      throw new Error(`Upload ${stream} was given up: ${error.message}`)
    },
  })
  return { uploads, transport, files: () => readdir(folder) }
}

describe('Uploads', () => {
  it('stops reading while its writes lag past the bound, and reads on once they are within it', async () => {
    const counts = new UploadCounts(MAX_UPLOADS, 1000)
    const { uploads, transport } = await connection(counts)
    expect(uploads.open(1, 500 + 3 * 4096)).toBe(true)

    // Under the bound it reads on.
    uploads.bytes(1, new Uint8Array(500))
    expect(transport.paused).toBe(false)
    expect(counts.unwritten('phone')).toBe(500)

    // Past it, it stops at once; what was already on its way still counts.
    uploads.bytes(1, new Uint8Array(4096))
    expect(transport.paused).toBe(true)
    uploads.bytes(1, new Uint8Array(4096))
    expect(counts.unwritten('phone')).toBe(500 + 2 * 4096)
    expect(transport.pauses).toBe(1)

    await expect.poll(() => transport.paused).toBe(false)
    expect(counts.unwritten('phone')).toBeLessThanOrEqual(1000)
    await expect.poll(() => counts.unwritten('phone')).toBe(0)
    uploads.bytes(1, new Uint8Array(4096))
    uploads.end(1)
    const bytes = await uploads.claim(1)
    expect(bytes.byteLength).toBe(500 + 3 * 4096)
    await expect.poll(() => transport.paused).toBe(false)
    expect(transport.pauses).toBe(2)
  })

  it("bounds the device's writes over all its connections", async () => {
    const counts = new UploadCounts(MAX_UPLOADS, 1000)
    const first = await connection(counts)
    const second = await connection(counts)
    const other = await connection(counts, 'laptop')
    first.uploads.open(1, 8192)
    second.uploads.open(1, 8192)
    other.uploads.open(1, 8192)

    first.uploads.bytes(1, new Uint8Array(600))
    second.uploads.bytes(1, new Uint8Array(600))
    // Neither passes the bound, but together they do: the one whose bytes did stops.
    expect(first.transport.paused).toBe(false)
    expect(second.transport.paused).toBe(true)
    // Another device's uploads are its own.
    other.uploads.bytes(1, new Uint8Array(600))
    expect(other.transport.paused).toBe(false)
    await expect.poll(() => second.transport.paused).toBe(false)
    expect(counts.unwritten('phone')).toBeLessThanOrEqual(1000)
    await expect.poll(() => counts.unwritten('phone')).toBe(0)
  })

  it('counts the bytes of an upload that goes before they are written, and stops waiting once closed', async () => {
    const counts = new UploadCounts(MAX_UPLOADS, 1000)
    const { uploads, transport, files } = await connection(counts)
    uploads.open(1, 8192)
    uploads.bytes(1, new Uint8Array(4096))
    expect(transport.paused).toBe(true)
    uploads.closeAll()
    await expect.poll(() => counts.unwritten('phone')).toBe(0)
    await expect.poll(() => files()).toEqual([])
    // A connection that ended does not read again.
    expect(transport.paused).toBe(true)
  })
})
