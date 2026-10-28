// Fake release archives for tests: written in plain Node.js, since bzip2 and zip tools are not on
// every machine, and served from a local HTTP server so an install takes its real download path.

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { onTestFinished } from 'vitest'

export interface ArchiveEntryFixture {
  name: string
  data: Buffer
  mode: number
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`
}

/** A ustar archive with plain file entries. */
export function archiveTar(entries: ArchiveEntryFixture[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    header.write(octal(entry.mode & 0o7777, 8), 100, 8, 'ascii')
    header.write(octal(0, 8), 108, 8, 'ascii')
    header.write(octal(0, 8), 116, 8, 'ascii')
    header.write(octal(entry.data.length, 12), 124, 12, 'ascii')
    header.write(octal(0, 12), 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    const data = Buffer.alloc(Math.ceil(entry.data.length / 512) * 512)
    entry.data.copy(data)
    blocks.push(header, data)
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

/** A zip archive with stored entries, carrying Unix mode bits as the registry's zips do. */
export function archiveZip(entries: ArchiveEntryFixture[]): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(0x0314, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x21, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE((entry.mode << 16) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    parts.push(local, name, data)
    directory.push(header, name)
    offset += local.length + name.length + data.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, central, end])
}

/** Serves files at their URL paths on 127.0.0.1, until the test that asked for it finishes. */
export async function serveArchives(
  routes: Record<string, Buffer | ((response: ServerResponse) => void)>,
): Promise<(path: string) => string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const route = routes[request.url ?? '']
    if (!route) {
      response.statusCode = 404
      response.end()
      return
    }
    if (typeof route === 'function') {
      route(response)
      return
    }
    response.setHeader('content-length', String(route.length))
    response.end(route)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        // A route that never answers holds its connection open; do not wait for it.
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return (urlPath) => `http://127.0.0.1:${port}${urlPath}`
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
