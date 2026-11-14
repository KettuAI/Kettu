// Screenshots and recordings of a mobile device, which the pane hands over to keep in Downloads.

import { open } from 'node:fs/promises'
import path from 'node:path'
import { safeName } from '@shared/file-name'
import { DEVICE_CAPTURE_KINDS, type DeviceCaptureKind } from '@shared/device-host'

/** A long recording at a phone's own size stays far under this. */
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const MAX_TRIES = 1_000

function bytesOf(value: unknown): Uint8Array {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value instanceof Uint8Array
        ? value
        : null
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) {
    throw new Error('A capture must be bytes, not empty and at most 2 GB')
  }
  return bytes
}

/** The file name of a capture: the device's name as a file system takes it, and the time. */
export function captureName(device: unknown, kind: unknown, now: Date): string {
  if (typeof device !== 'string' || device.length > 256) {
    throw new Error('A capture names its device')
  }
  if (!DEVICE_CAPTURE_KINDS.includes(kind as DeviceCaptureKind)) {
    throw new Error('A capture is a png, mp4 or webm')
  }
  const two = (value: number): string => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
  const time = `${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`
  return `${safeName(device, 'Device')} ${date} at ${time}.${kind as DeviceCaptureKind}`
}

/** `devices:save-capture`: writes the capture into `folder` without replacing a file; its path. */
export async function saveCapture(
  folder: string,
  device: unknown,
  kind: unknown,
  data: unknown,
): Promise<string> {
  const name = captureName(device, kind, new Date())
  const bytes = bytesOf(data)
  const extension = path.extname(name)
  const stem = name.slice(0, -extension.length)
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const file = path.join(folder, attempt === 1 ? name : `${stem} ${attempt}${extension}`)
    const handle = await open(file, 'wx').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') return null
      throw error
    })
    if (!handle) continue
    try {
      await handle.writeFile(bytes)
    } finally {
      await handle.close()
    }
    return file
  }
  throw new Error('Too many captures with this name')
}
