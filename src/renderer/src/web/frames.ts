// Artifact frames in the web client. The session opens each frame on the host, which then serves
// the artifact's files on its direct port under the folder it answers with, sandboxed on an opaque
// origin with the artifact policy; the frames load from there, and nothing passes through this page.

import type { ArtifactContent } from '@shared/artifacts'
import type { ArtifactOpenResult } from '@shared/ipc'
import { errorCode } from '@renderer/lib/host'
import type { HostLink } from './link'

const FRAME_PATH = '/frame/'

/** `artifact:open`: the frame's folder on the host's origin, which `close` gives back. */
export async function openFrame(link: HostLink, id: string): Promise<ArtifactOpenResult> {
  let path: unknown
  try {
    path = ((await link.request('artifacts.openFrame', { id })) as { path?: unknown } | null)?.path
  } catch (error) {
    if (errorCode(error) === 'not_found') return { failed: 'not_found' }
    throw error
  }
  if (typeof path !== 'string' || !path.startsWith(FRAME_PATH) || !path.endsWith('/')) {
    throw new Error('The host named no frame for the artifact')
  }
  return { url: `${location.origin}${path}` }
}

/** `artifact:close`: the host stops serving the frame at `url`. */
export async function closeFrame(link: HostLink, url: string): Promise<void> {
  const parsed = URL.parse(url)
  if (!parsed || parsed.origin !== location.origin) return
  await link.request('artifacts.closeFrame', { path: parsed.pathname })
}

/** The directory picker of the browsers that have one. */
type DirectoryPicker = (options?: { mode?: 'readwrite' }) => Promise<FileSystemDirectoryHandle>

/**
 * `artifact:export` for a version of several files: each into the folder the user picks, in the
 * folders its path names. False when the user cancelled.
 */
export async function exportFiles(
  link: HostLink,
  id: string,
  read: ArtifactContent,
): Promise<boolean> {
  const browser = window as { showDirectoryPicker?: DirectoryPicker }
  if (!browser.showDirectoryPicker) throw new Error('This browser cannot save a folder')
  let root: FileSystemDirectoryHandle
  try {
    root = await browser.showDirectoryPicker({ mode: 'readwrite' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return false
    throw error
  }
  for (const file of read.files) {
    const { bytes } = (await link.request('artifacts.file', {
      id,
      version: read.version,
      path: file.path,
    })) as { bytes: ArrayBuffer }
    const segments = file.path.split('/')
    let folder = root
    for (const name of segments.slice(0, -1)) {
      folder = await folder.getDirectoryHandle(name, { create: true })
    }
    const handle = await folder.getFileHandle(segments.at(-1)!, { create: true })
    const writable = await handle.createWritable()
    await writable.write(bytes)
    await writable.close()
  }
  return true
}
