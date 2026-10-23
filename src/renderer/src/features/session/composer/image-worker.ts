// Thumbnails and scaling for attached images, off the renderer's main thread.

import { IMAGE_BYTES, IMAGE_SIDE, MODEL_IMAGE_TYPES, THUMB_SIDE } from '@shared/attachments'
import type { ImageJob, ImageResult } from './image-work'

const scope = self as unknown as Worker

scope.onmessage = async (event: MessageEvent<ImageJob>) => {
  const { id, blob } = event.data
  const started = performance.now()
  try {
    const result = await prepare(blob)
    const message: ImageResult = { id, ...result, ms: performance.now() - started }
    scope.postMessage(message, [result.bytes])
  } catch (error) {
    const message: ImageResult = {
      id,
      error: error instanceof TooLarge ? 'too-large' : 'unreadable',
      detail: String((error as Error)?.message ?? error),
    }
    scope.postMessage(message)
  }
}

class TooLarge extends Error {}

async function prepare(blob: Blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const { width, height } = bitmap
    const thumb = await encode(bitmap, THUMB_SIDE, 'image/webp', 0.82)
    const tooLarge = Math.max(width, height) > IMAGE_SIDE || blob.size > IMAGE_BYTES
    if (!tooLarge && MODEL_IMAGE_TYPES.includes(blob.type)) {
      return {
        thumb: await dataUrl(thumb),
        width,
        height,
        bytes: await blob.arrayBuffer(),
        mimeType: blob.type,
        scaled: null,
      }
    }
    // Too large for every model, or a type no model takes: re-encoded, transparency kept. A PNG
    // can still be over the limit at 2000 px, so it gets smaller until it fits.
    let canvas = draw(bitmap, IMAGE_SIDE)
    const type = hasTransparency(canvas) ? 'image/png' : 'image/jpeg'
    let out = await canvas.convertToBlob({ type, quality: 0.9 })
    while (out.size > IMAGE_BYTES) {
      const side = Math.floor(Math.max(canvas.width, canvas.height) * 0.8)
      if (side < THUMB_SIDE) throw new TooLarge(`Still ${out.size} bytes at ${canvas.width} px`)
      canvas = draw(bitmap, side)
      out = await canvas.convertToBlob({ type, quality: 0.9 })
    }
    const resized = canvas.width !== width || canvas.height !== height
    return {
      thumb: await dataUrl(thumb),
      width,
      height,
      bytes: await out.arrayBuffer(),
      mimeType: type,
      scaled: resized ? { width: canvas.width, height: canvas.height } : null,
    }
  } finally {
    bitmap.close()
  }
}

function draw(bitmap: ImageBitmap, side: number): OffscreenCanvas {
  const k = Math.min(1, side / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * k)),
    Math.max(1, Math.round(bitmap.height * k)),
  )
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No 2D context for the image')
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas
}

function encode(bitmap: ImageBitmap, side: number, type: string, quality: number): Promise<Blob> {
  return draw(bitmap, side).convertToBlob({ type, quality })
}

function hasTransparency(canvas: OffscreenCanvas): boolean {
  const context = canvas.getContext('2d')
  if (!context) return false
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true
  return false
}

async function dataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  // Chunks keep the argument list of fromCharCode short.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${blob.type};base64,${btoa(binary)}`
}
