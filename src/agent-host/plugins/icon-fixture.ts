// The headers of images of a given size, as the icon check reads them; nothing past the header is
// a real picture.

export function png(width: number, height = width): Buffer {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'latin1')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  head[24] = 8
  head[25] = 6
  return head
}

export function jpeg(width: number, height = width): Buffer {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from('JFIF\0'),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ])
  const frame = Buffer.alloc(19)
  frame.writeUInt16BE(0xffc0, 0)
  frame.writeUInt16BE(17, 2)
  frame[4] = 8
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  frame[9] = 3
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, Buffer.from([0xff, 0xd9])])
}

function riff(chunk: string, body: Buffer): Buffer {
  const head = Buffer.alloc(20)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(12 + body.length, 4)
  head.write('WEBP', 8, 'latin1')
  head.write(chunk, 12, 'latin1')
  head.writeUInt32LE(body.length, 16)
  return Buffer.concat([head, body])
}

/** A lossy WebP; `lossless` and `extended` give the other two headers. */
export function webp(
  width: number,
  height = width,
  form: 'lossy' | 'lossless' | 'extended' = 'lossy',
): Buffer {
  if (form === 'lossy') {
    const body = Buffer.alloc(10)
    body.set([0x9d, 0x01, 0x2a], 3)
    body.writeUInt16LE(width, 6)
    body.writeUInt16LE(height, 8)
    return riff('VP8 ', body)
  }
  if (form === 'lossless') {
    const w = width - 1
    const h = height - 1
    const body = Buffer.from([
      0x2f,
      w & 0xff,
      ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
      (h >> 2) & 0xff,
      (h >> 10) & 0x0f,
      0,
      0,
      0,
      0,
      0,
    ])
    return riff('VP8L', body)
  }
  const body = Buffer.alloc(10)
  body.writeUIntLE(width - 1, 4, 3)
  body.writeUIntLE(height - 1, 7, 3)
  return riff('VP8X', body)
}
