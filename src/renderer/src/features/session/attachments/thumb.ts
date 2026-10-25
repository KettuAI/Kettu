// A replayed image has no thumbnail: the host cannot draw one, so the renderer makes it from the
// bytes the thread store keeps, the first time its tile shows, and uses it for the rest of the run.

import type { Attachment } from '@shared/thread'
import { host } from '@renderer/lib/host'
import { prepareImage } from '../composer/image-work'

const thumbs = new Map<string, string | null>()
const pending = new Map<string, Promise<string | null>>()

/** An image attachment's thumbnail, made once for its bytes and kept by their hash. */
export function replayThumb(
  sessionId: string,
  attachment: Pick<Attachment, 'type' | 'thumb' | 'blob'>,
): Promise<string | null> {
  if (attachment.thumb) return Promise.resolve(attachment.thumb)
  const hash = attachment.blob
  if (attachment.type !== 'image' || !hash) return Promise.resolve(null)
  if (thumbs.has(hash)) return Promise.resolve(thumbs.get(hash) ?? null)
  const running = pending.get(hash)
  if (running) return running
  const request = host('sessions.blob', { sessionId, hash })
    .then(({ mimeType, bytes }) => prepareImage(new Blob([bytes], { type: mimeType })))
    .then((image) => image.thumb)
    .catch(() => null)
    .then((thumb) => {
      thumbs.set(hash, thumb)
      pending.delete(hash)
      return thumb
    })
  pending.set(hash, request)
  return request
}
