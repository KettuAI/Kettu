// A plugin's own logo, read from the package on this computer as a data URL. The path comes from
// the harness, and a manifest names it, so only a small file that really is an image is read.

import { open } from 'node:fs/promises'
import path from 'node:path'

export const LOGO_MAX_BYTES = 512 * 1024

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

function startsWith(bytes: Uint8Array, signature: number[], at = 0): boolean {
  return signature.every((byte, i) => bytes[at + i] === byte)
}

/** Whether the bytes are the image their type says, so no other file passes as a logo. */
export function isImage(bytes: Uint8Array, type: string): boolean {
  switch (type) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff])
    case 'image/webp':
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      )
    case 'image/svg+xml': {
      if (bytes.includes(0)) return false
      const head = new TextDecoder().decode(bytes.subarray(0, 4096))
      return /<svg[\s>]/i.test(head)
    }
    default:
      return false
  }
}

/** The file as a data URL; null when it is missing, too big, or not an image of its type. */
export async function readLogo(file: string): Promise<string | null> {
  if (!path.isAbsolute(file)) return null
  const type = TYPES[path.extname(file).toLowerCase()]
  if (!type) return null
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > LOGO_MAX_BYTES) return null
    const bytes = await handle.readFile()
    if (!isImage(bytes, type)) return null
    return `data:${type};base64,${bytes.toString('base64')}`
  } finally {
    await handle.close()
  }
}
