// Exports of typed artifacts in the web client: the host converts the version, and the browser
// saves what it made, one file as a download or Markdown with its pictures into a folder.

import { EXPORT_EXTENSIONS, EXPORT_TYPES, type ArtifactExportFormat } from '@shared/artifact-types'
import { safeName } from '@shared/file-name'
import type { HostLink } from '@shared/remote/link'
import { downloadFile } from './media'

/** The directory picker of the browsers that have one. */
type DirectoryPicker = (options?: { mode?: 'readwrite' }) => Promise<FileSystemDirectoryHandle>

/** Whether this browser can save a folder, which Markdown with pictures needs. */
export function canSaveFolder(): boolean {
  return (
    typeof (window as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker === 'function'
  )
}

async function saveFolder(files: { path: string; bytes: ArrayBuffer }[]): Promise<boolean> {
  const picker = (window as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
  if (!picker) throw new Error('This browser cannot save a folder')
  let root: FileSystemDirectoryHandle
  try {
    root = await picker({ mode: 'readwrite' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return false
    throw error
  }
  for (const file of files) {
    const segments = file.path.split('/')
    let folder = root
    for (const name of segments.slice(0, -1)) {
      folder = await folder.getDirectoryHandle(name, { create: true })
    }
    const writable = await (
      await folder.getFileHandle(segments.at(-1)!, { create: true })
    ).createWritable()
    await writable.write(file.bytes)
    await writable.close()
  }
  return true
}

/** `artifact:export-as`: the host's conversion, saved by the browser. */
export async function exportAs(
  link: HostLink,
  id: string,
  version: number,
  format: ArtifactExportFormat,
  printPdf: () => Promise<string>,
): Promise<boolean> {
  if (format === 'pdf') {
    const bytes = Uint8Array.from(atob(await printPdf()), (c) => c.charCodeAt(0))
    const { title } = (await link.request('artifacts.read', { id, version })) as { title: string }
    downloadFile(new Blob([bytes], { type: EXPORT_TYPES.pdf }), `${safeName(title, id)}.pdf`)
    return true
  }
  const { title, files } = (await link.request('artifacts.export', { id, version, format })) as {
    title: string
    files: { path: string; bytes: ArrayBuffer }[]
  }
  if (files.length > 1) return saveFolder(files)
  const name = `${safeName(title, id)}.${EXPORT_EXTENSIONS[format]}`
  downloadFile(new Blob([files[0]!.bytes], { type: EXPORT_TYPES[format] }), name)
  return true
}
