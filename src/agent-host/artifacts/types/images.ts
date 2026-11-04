// The pictures typed artifacts hold: their kind from their first bytes, and their size, which the
// exports lay them out by.

export interface ImageInfo {
  type: 'png' | 'jpeg' | 'gif'
  /** In pixels; 0 when the header does not say. */
  width: number
  height: number
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte)
}

/** The picture's kind and size, or null for bytes that are none of the kinds a type holds. */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (startsWith(bytes, PNG)) {
    if (bytes.length < 24) return { type: 'png', width: 0, height: 0 }
    return { type: 'png', width: view.getUint32(16), height: view.getUint32(20) }
  }
  const head = String.fromCharCode(...bytes.subarray(0, 6))
  if (head === 'GIF87a' || head === 'GIF89a') {
    if (bytes.length < 10) return { type: 'gif', width: 0, height: 0 }
    return { type: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { type: 'jpeg', ...jpegSize(bytes, view) }
  return null
}

/** The size in a JPEG's start-of-frame segment. */
function jpegSize(bytes: Uint8Array, view: DataView): { width: number; height: number } {
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at++
      continue
    }
    const marker = bytes[at + 1]!
    // Fill bytes, and the markers that carry no length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += marker === 0xff ? 1 : 2
      continue
    }
    const length = view.getUint16(at + 2)
    const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (frame) return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
    at += 2 + length
  }
  return { width: 0, height: 0 }
}
