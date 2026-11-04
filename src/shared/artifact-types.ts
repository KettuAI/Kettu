// Artifact types: what Kettu shows with a viewer of its own, the content an artifact made from one
// holds, and the page served in place of its entry, alike for the host and the clients.

import { ARTIFACT_RESERVED } from './artifact-files'
import type { Locale } from './locale'

/** The built-in types. An artifact made from one holds only its content files. */
export const ARTIFACT_TYPES = ['document', 'slides'] as const

export type ArtifactTypeName = (typeof ARTIFACT_TYPES)[number]

export function isArtifactTypeName(value: unknown): value is ArtifactTypeName {
  return (ARTIFACT_TYPES as readonly unknown[]).includes(value)
}

/** A version's type and the version of the type's content format it was written in. */
export interface ArtifactTypeInfo {
  name: ArtifactTypeName
  format: number
}

/** The newest format of each type, which new artifacts are written in. */
export const CURRENT_FORMATS: Readonly<Record<ArtifactTypeName, number>> = {
  document: 1,
  slides: 1,
}

/** The file holding each type's content, beside its images. */
export const CONTENT_ENTRIES: Readonly<Record<ArtifactTypeName, string>> = {
  document: 'document.md',
  slides: 'slides.json',
}

/** Where both types keep their pictures. */
export const IMAGES_FOLDER = 'images/'

/** What a type exports to; each is one file, except Markdown with pictures, a folder. */
export type ArtifactExportFormat = 'docx' | 'md' | 'pptx' | 'pdf'

export const EXPORT_FORMATS: Readonly<Record<ArtifactTypeName, readonly ArtifactExportFormat[]>> = {
  document: ['docx', 'md'],
  slides: ['pptx', 'pdf'],
}

export const EXPORT_EXTENSIONS: Readonly<Record<ArtifactExportFormat, string>> = {
  docx: 'docx',
  md: 'md',
  pptx: 'pptx',
  pdf: 'pdf',
}

export const EXPORT_TYPES: Readonly<Record<ArtifactExportFormat, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
}

export function isExportFormat(
  type: ArtifactTypeName,
  value: unknown,
): value is ArtifactExportFormat {
  return (EXPORT_FORMATS[type] as readonly unknown[]).includes(value)
}

/** A file an export makes: its path in the folder it is saved to, or its name alone. */
export interface ExportedFile {
  path: string
  bytes: Uint8Array
}

/** The viewers' built files, on every typed artifact's origin. */
export const VIEWER_PREFIX = `${ARTIFACT_RESERVED}/viewer/`

/**
 * The viewer of each format a type has had, by its built entry's name. Kettu keeps the old ones,
 * so an artifact whose content could not be moved to a new format still shows.
 */
export const VIEWER_ENTRIES: Readonly<Record<ArtifactTypeName, Readonly<Record<number, string>>>> =
  {
    document: { 1: 'document' },
    slides: { 1: 'slides' },
  }

/** How a viewer page shows: as the user sees it, on a card's thumbnail, or every page to print. */
export type ViewerView = 'normal' | 'thumbnail' | 'print'

/** What the served page tells its viewer, in its `kettu-viewer` script element. */
export interface ViewerConfig {
  type: ArtifactTypeName
  format: number
  /** The version the page shows. */
  version: number
  entry: string
  locale: Locale
}

export const VIEWER_CONFIG_ID = 'kettu-viewer'

/**
 * The page served in place of a typed artifact's entry: the viewer of its format, loaded from
 * `base`, the way back to the origin's root from the page, so it works under a version's path and
 * under a web client frame's folder alike. Null for a format this build has no viewer for. Every
 * value in it is a checked name or number.
 */
export function viewerPage(
  type: ArtifactTypeInfo,
  version: number,
  locale: Locale,
  base: string,
): string | null {
  const name = VIEWER_ENTRIES[type.name]?.[type.format]
  if (!name || !/^(?:\.\.\/)*$/.test(base)) return null
  const config: ViewerConfig = {
    type: type.name,
    format: type.format,
    version,
    entry: CONTENT_ENTRIES[type.name],
    locale,
  }
  const asset = `${base}${VIEWER_PREFIX}${name}`
  return (
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<link rel="stylesheet" href="${asset}.css">` +
    `<script type="application/json" id="${VIEWER_CONFIG_ID}">${JSON.stringify(config)}</script>` +
    `<script type="module" src="${asset}.js"></script>` +
    '</head><body><div id="root"></div></body></html>'
  )
}

/** The way back to the origin's root from the entry page of a version, or of the latest. */
export function viewerBase(version: number | null): string {
  // The entry of a version lies under `_kettu/v/<n>/`.
  return version === null ? '' : '../../../'
}
