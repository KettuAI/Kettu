// Tarballs as GitHub makes them, built in memory for tests.

export const COMMIT = '2c5958ecac7cee2b583967a2c4981d0f4a75c579'

/** One 512-byte ustar header, with its checksum. */
function header(name: string, type: string, size: number, link = ''): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write('0000644\0', 100)
  block.write('0000000\0', 108)
  block.write('0000000\0', 116)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  block.write('00000000000\0', 136)
  block.write('        ', 148)
  block.write(type, 156)
  block.write(link, 157, 100, 'utf8')
  block.write('ustar\0', 257)
  block.write('00', 263)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

/** A tarball as GitHub makes one: a pax global header naming the commit, then the entries. */
export function tarball(
  entries: { name: string; type?: string; data?: string; link?: string }[],
): Buffer {
  const record = `52 comment=${COMMIT}\n`
  const parts = [header('pax_global_header', 'g', record.length), padded(Buffer.from(record))]
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    parts.push(header(entry.name, entry.type ?? '0', data.length, entry.link))
    if (data.length > 0) parts.push(padded(data))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}
