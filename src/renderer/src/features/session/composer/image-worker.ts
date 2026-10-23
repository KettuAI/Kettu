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
    const message: ImageResult = { id, error: String((error as Error)?.message ?? error) }
    scope.postMessage(message)
  }
}

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
    // Too large for every model, or a type no model takes: re-encoded, transparency kept.
    const canvas = draw(bitmap, IMAGE_SIDE)
    const type = hasTransparency(canvas) ? 'image/png' : 'image/jpeg'
    const out = await canvas.convertToBlob({ type, quality: 0.9 })
    return {
      thumb: await dataUrl(thumb),
      width,
      height,
      bytes: await out.arrayBuffer(),
      mimeType: type,
      scaled: { width: canvas.width, height: canvas.height },
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
