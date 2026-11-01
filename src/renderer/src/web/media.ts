// Media in the web client: where a window asks main's media scheme for a grant, the browser reads
// the file's bytes over the channel with `media.read` and shows them from a blob URL.

import type { DeviceFileContent, FileContent } from '@shared/files'
import type { MediaGrant, MediaOpenResult } from '@shared/media'
import type { MediaReadParams, MediaReadResult } from '@shared/remote/streams'
import type { HostLink } from './link'

/** Blob URLs kept alive; older ones are revoked, and a view that still shows one asks again. */
const MAX_URLS = 100

/** Larger media is not read into the page, which holds it all in memory. */
export const MAX_MEDIA_BYTES = 128 * 1024 * 1024

const urls: string[] = []

type ReadResult =
  | (Omit<Extract<MediaReadResult, { kind: 'granted' }>, 'bytes'> & { bytes: ArrayBuffer })
  | Exclude<MediaReadResult, { kind: 'granted' }>

function keep(url: string): void {
  urls.push(url)
  while (urls.length > MAX_URLS) URL.revokeObjectURL(urls.shift()!)
}

/** A grant as a window's would be, for the bytes of a file on the host. */
async function grant(link: HostLink, params: MediaReadParams): Promise<MediaOpenResult> {
  const read = (await link.request('media.read', params)) as ReadResult
  if (read.kind !== 'granted') return read
  const { media } = read
  if (media.size > MAX_MEDIA_BYTES) return { kind: 'not_media' }
  const url = URL.createObjectURL(new Blob([read.bytes], { type: media.mimeType }))
  keep(url)
  const shown: MediaGrant = {
    url,
    kind: media.kind,
    mimeType: media.mimeType,
    size: media.size,
    ...(media.width === undefined ? {} : { width: media.width }),
    ...(media.height === undefined ? {} : { height: media.height }),
  }
  return { kind: 'granted', grant: shown }
}

/**
 * The requests a window answers with main's media scheme, answered over the channel instead; null
 * for every other request, which goes to the host as it is.
 */
export function mediaRequest(
  link: HostLink,
  method: string,
  params: unknown,
): Promise<unknown> | null {
  if (method === 'media.open') return grant(link, params as MediaReadParams)
  if (method !== 'files.read') return null
  const { projectPath } = params as { projectPath: string }
  return link.request(method, params).then(async (result) => {
    const content = result as DeviceFileContent
    if (content.kind !== 'media') return content
    const opened = await grant(link, { projectPath, path: content.path })
    if (opened.kind !== 'granted') {
      return { kind: 'binary', path: content.path, size: content.media.size } satisfies FileContent
    }
    return { kind: 'media', path: content.path, grant: opened.grant } satisfies FileContent
  })
}

/** Hands the browser a file to save. */
export function downloadFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
