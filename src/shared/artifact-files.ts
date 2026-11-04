// The files of an artifact: the paths they may have, the limits on them and the types they are
// served with, alike for the host that keeps them and the clients that serve and export them.

/** The page an artifact opens on; every version has it. */
export const ARTIFACT_ENTRY = 'index.html'

/** Kettu's own paths on every artifact origin start with it, so no artifact file may. */
export const ARTIFACT_RESERVED = '_kettu'

const MIB = 1024 * 1024
/** A file whose text is written in a tool call. */
export const INLINE_FILE_BYTES = 5 * MIB
/** A file read from disk: from a session's working folder, or one the user imports. */
export const DISK_FILE_BYTES = 20 * MIB
/** All the files of one version. */
export const VERSION_BYTES = 64 * MIB
export const VERSION_FILES = 256
export const ARTIFACT_PATH_CHARS = 512
const SEGMENT_CHARS = 255

// Besides control characters, what Windows refuses in a file name, so every version exports there.
const REFUSED_CHARACTERS = new Set(['\\', ':', '*', '?', '"', '<', '>', '|'])

function refusedCharacter(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i)
    if (c < 0x20 || c === 0x7f || REFUSED_CHARACTERS.has(path[i]!)) return true
  }
  return false
}

/** What is wrong with `path` as the path of an artifact's file, or null when it may be one. */
export function artifactPathProblem(path: string): string | null {
  if (path === '') return 'is empty'
  if (path.length > ARTIFACT_PATH_CHARS) return `is longer than ${ARTIFACT_PATH_CHARS} characters`
  if (path.startsWith('/')) return 'starts with /; paths are relative, such as assets/logo.png'
  if (refusedCharacter(path)) return 'has a backslash, a control character or one of : * ? " < > |'
  for (const segment of path.split('/')) {
    if (segment === '') return 'has an empty segment'
    if (segment === '.' || segment === '..') return `has a ${segment} segment`
    if (segment.length > SEGMENT_CHARS) return `has a name longer than ${SEGMENT_CHARS} characters`
    if (/[. ]$/.test(segment)) return 'has a name that ends in a dot or a space'
  }
  if (path.startsWith(ARTIFACT_RESERVED)) {
    return `starts with ${ARTIFACT_RESERVED}, which Kettu keeps for itself`
  }
  return null
}

/**
 * Two of `paths` that differ only in case, which a case-insensitive disk would make one file on
 * export, or null. Paths are case-sensitive, so such a pair is refused rather than merged.
 */
export function caseClash(paths: Iterable<string>): [string, string] | null {
  const seen = new Map<string, string>()
  for (const path of paths) {
    const key = path.normalize('NFC').toLowerCase()
    const other = seen.get(key)
    if (other !== undefined && other !== path) return [other, path]
    seen.set(key, path)
  }
  return null
}

const TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
}

/** The type a file is served with, by its extension; an unknown one is plain bytes. */
export function artifactFileType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return TYPES[extension] ?? 'application/octet-stream'
}

/** Whether a file of this type is text, which can be read and edited as such. */
export function isTextType(type: string): boolean {
  return (
    type.startsWith('text/') ||
    type.startsWith('application/json') ||
    type.startsWith('application/manifest+json') ||
    type.startsWith('application/xml') ||
    type === 'image/svg+xml' ||
    type === 'model/gltf+json'
  )
}

export function isHtmlPath(path: string): boolean {
  return artifactFileType(path).startsWith('text/html')
}
