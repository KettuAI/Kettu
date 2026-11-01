// Artifact pages in the web client. Each frame loads the host's frame shell under `/frame/<id>/`,
// which the host serves sandboxed on an opaque origin with the artifact policy; the shell asks
// for its page, and the page's HTML, read over the encrypted channel, is posted to it here.

import { pageStyle, parseArtifactQuery, withStyle } from '@shared/artifact-page'
import type { HostLink } from './link'

const FRAME_PATH = '/frame/'

/** The origin URL a window would get from main's `artifact:open`, here the shell's folder. */
export function frameArtifact(id: string): string {
  return `${location.origin}${FRAME_PATH}${encodeURIComponent(id)}/`
}

/** What a frame's path asks for, or null when it names no artifact. */
export function parseFramePath(path: string): {
  id: string
  version: number | null
  page: { group: number; index: number } | null
} | null {
  const url = URL.parse(path, 'http://frame.invalid')
  if (!url || !url.pathname.startsWith(FRAME_PATH)) return null
  const rest = url.pathname.slice(FRAME_PATH.length)
  if (!rest.endsWith('/') || rest.slice(0, -1).includes('/')) return null
  let id: string
  try {
    id = decodeURIComponent(rest.slice(0, -1))
  } catch {
    return null
  }
  if (id === '') return null
  const query = parseArtifactQuery(url.searchParams)
  return query ? { id, ...query } : null
}

/** Answers every frame shell of this page that asks for its artifact. */
export function serveFrames(link: HostLink): void {
  window.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; path?: unknown } | null
    if (data?.type !== 'kettu:frame-ready' || typeof data.path !== 'string') return
    // Only a frame in this page, never another window that found ours.
    const frame = [...document.querySelectorAll('iframe')].find(
      (element) => element.contentWindow === event.source,
    )
    const wanted = parseFramePath(data.path)
    if (!frame?.contentWindow || !wanted) return
    const target = frame.contentWindow
    const params =
      wanted.version === null ? { id: wanted.id } : { id: wanted.id, version: wanted.version }
    void link.request('artifacts.read', params).then(
      (read) => {
        const { html } = read as { html: string }
        const shown = wanted.page
          ? withStyle(html, pageStyle(wanted.page.group, wanted.page.index))
          : html
        target.postMessage({ type: 'kettu:frame-html', html: shown }, '*')
      },
      (error: unknown) => console.error(`Could not read ${wanted.id} for its frame`, error),
    )
  })
}
