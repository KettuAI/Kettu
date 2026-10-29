// What the players play: a file the thread names, through its grant, or base64 the thread carries,
// which has no file to show.

import type { MediaGrant } from '@shared/media'

export type PlayedMedia =
  | { kind: 'file'; path: string; grant: MediaGrant }
  | { kind: 'carried'; mimeType: string; data: string; size: number }

export const playedUrl = (media: PlayedMedia): string =>
  media.kind === 'file' ? media.grant.url : `data:${media.mimeType};base64,${media.data}`

export function base64Bytes(data: string): Uint8Array {
  const text = atob(data)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

/** Save as… for carried bytes; false when the dialog was cancelled. */
export function saveCarried(mimeType: string, data: string, name: string): Promise<boolean> {
  return window.kettu.media.saveAs({ bytes: base64Bytes(data), mimeType, name })
}
