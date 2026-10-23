import { i18n } from '@renderer/lib/i18n'
import ImageWorker from './image-worker?worker'

export interface ImageJob {
  id: number
  blob: Blob
}

export interface PreparedImage {
  /** The 224 px WebP thumbnail, as a data URL. */
  thumb: string
  width: number
  height: number
  /** What is sent: the original, or a copy scaled to fit 2,000 px and 3.75 MB. */
  bytes: ArrayBuffer
  mimeType: string
  scaled: { width: number; height: number } | null
  ms: number
}

export type ImageResult = { id: number } & (
  PreparedImage | { error: 'unreadable' | 'too-large'; detail: string }
)

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, (result: ImageResult) => void>()

/** Reads an image in a worker: its thumbnail, its size, and the bytes to send. */
export function prepareImage(blob: Blob): Promise<PreparedImage> {
  if (!worker) {
    worker = new ImageWorker()
    worker.onmessage = (event: MessageEvent<ImageResult>) => {
      const settle = pending.get(event.data.id)
      pending.delete(event.data.id)
      settle?.(event.data)
    }
  }
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, (result) => {
      if (!('error' in result)) return resolve(result)
      console.warn(`Could not prepare an image: ${result.detail}`)
      const key = result.error === 'too-large' ? 'imageTooLarge' : 'cannotRead'
      reject(new Error(i18n.t(`composer:attachments.${key}`)))
    })
    const job: ImageJob = { id, blob }
    worker!.postMessage(job)
  })
}
