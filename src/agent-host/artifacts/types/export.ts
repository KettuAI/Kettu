// Exports of typed artifacts made on the host: a document to Word and Markdown, a deck to
// PowerPoint. A deck's PDF is printed by a client that renders its viewer.

import { isImagePath } from '@shared/artifact-document'
import { parseDeck } from '@shared/artifact-slides'
import {
  type ArtifactExportFormat,
  CONTENT_ENTRIES,
  EXPORT_EXTENSIONS,
  type ExportedFile,
  isExportFormat,
} from '@shared/artifact-types'
import type { ArtifactStore, FoundVersion } from '../store'

/** An export this host cannot make: of a plain artifact, or to a format the type has not. */
export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

/** The formats the host converts to itself. */
export function exportsOnHost(format: ArtifactExportFormat): boolean {
  return format !== 'pdf'
}

/**
 * The version as `format`: one file named after its content, or for Markdown with pictures, the
 * content file and its pictures under their paths, to save in a folder.
 */
export async function exportVersion(
  store: ArtifactStore,
  found: FoundVersion,
  format: ArtifactExportFormat,
): Promise<ExportedFile[]> {
  const type = found.type
  if (!type) throw new ExportError(`${found.artifact.id} is not made from a type`)
  if (!isExportFormat(type.name, format) || !exportsOnHost(format)) {
    throw new ExportError(`A ${type.name} does not export to ${format} on the host`)
  }
  const entry = CONTENT_ENTRIES[type.name]
  const images = new Map<string, Uint8Array>()
  let text = ''
  for (const file of found.files) {
    if (file.path === entry) text = (await store.bytes(found, file)).toString('utf8')
    else if (isImagePath(file.path)) images.set(file.path, await store.bytes(found, file))
  }
  const name = `${entry.slice(0, entry.lastIndexOf('.'))}.${EXPORT_EXTENSIONS[format]}`
  const title = found.artifact.title
  switch (format) {
    case 'md':
      return [
        { path: entry, bytes: Buffer.from(text, 'utf8') },
        ...[...images].map(([path, bytes]) => ({ path, bytes })),
      ]
    case 'docx': {
      const { documentDocx } = await import('./docx')
      return [{ path: name, bytes: await documentDocx(title, text, images) }]
    }
    case 'pptx': {
      const parsed = parseDeck(text)
      if ('problems' in parsed) throw new ExportError(parsed.problems.join(' '))
      const { slidesPptx } = await import('./pptx')
      return [{ path: name, bytes: await slidesPptx(title, parsed.deck, images) }]
    }
    default:
      throw new ExportError(`${format} is not made on the host`)
  }
}
