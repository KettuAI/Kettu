import { createContext, useContext } from 'react'
import { relativePath } from '@renderer/lib/format'
import { useFilesStore } from '@renderer/stores/files'

/** The project of the thread being shown, for telling which references in it name its files. */
export const ProjectPathContext = createContext<string | null>(null)

export interface FileRef {
  /** Relative to the project's root, with `/`. */
  path: string
  line: number | null
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const LINE_SUFFIX = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/

/**
 * A file reference as replies write them: `src/x.ts`, `./src/x.ts:12`, `src/x.ts:12:5`,
 * `src/x.ts#L12`, or an absolute path inside the project. Whether the file exists is for the
 * caller to check against the project's files. Null for anything else, such as a URL.
 */
export function parseFileRef(text: string, projectPath: string): FileRef | null {
  let value = text.trim()
  if (!value || /\s/.test(value) || value.startsWith('#') || value.startsWith('//')) return null
  // A Windows drive path has a colon too, so only other schemes are URLs.
  if (SCHEME.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null
  try {
    value = decodeURI(value)
  } catch {
    return null
  }
  let line: number | null = null
  const suffix = LINE_SUFFIX.exec(value)
  if (suffix) {
    value = suffix[1]!
    line = Number(suffix[2] ?? suffix[3])
  }
  const inside = relativePath(value, projectPath)
  if (inside !== value) value = inside
  else if (value.startsWith('/') || /^[a-z]:[\\/]/i.test(value)) return null
  value = value.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!value || value.split('/').includes('..')) return null
  return { path: value, line: line && line > 0 ? line : null }
}

/** The reference when it names one of the shown project's files, else null. */
export function useFileRef(text: string | null): (FileRef & { projectPath: string }) | null {
  const projectPath = useContext(ProjectPathContext)
  const ref = projectPath && text ? parseFileRef(text, projectPath) : null
  const known = useFilesStore(
    (s) => !!ref && !!projectPath && !!s.byProject[projectPath]?.known.has(ref.path),
  )
  return known && ref && projectPath ? { ...ref, projectPath } : null
}
