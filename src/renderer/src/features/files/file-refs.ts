import { createContext, useContext, useEffect } from 'react'
import type { AgentId } from '@shared/agents'
import { hostPath } from '@renderer/lib/host-paths'
import { SessionIdContext } from '@renderer/features/session/media/grants'
import { agentFolderKey, ensureAgentFolder, useFilesStore } from '@renderer/stores/files'
import { useSessionsStore } from '@renderer/stores/sessions'

/** The project of the thread being shown, for telling which references in it name its files. */
export const ProjectPathContext = createContext<string | null>(null)

export interface FileRef {
  /** Relative to the project's root, with `/`. */
  path: string
  line: number | null
}

/** A reference as a reply wrote it, and whether it named the file by its full path. */
interface ParsedRef extends FileRef {
  absolute: boolean
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const FILE_URI = /^file:/i
const DRIVE = /^[a-z]:[\\/]/i
// `/C:/x`, a Windows path as a URL's path writes it.
const ROOTED_DRIVE = /^\/[a-z]:[\\/]/i
const LINE_SUFFIX = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/

/** The path a `file:` URI names on this computer; null for another host's or a malformed one. */
function fileUriPath(uri: string): string | null {
  const url = URL.parse(uri)
  if (!url || (url.host !== '' && url.host !== 'localhost')) return null
  try {
    const path = decodeURIComponent(url.pathname) + url.hash
    return ROOTED_DRIVE.test(path) ? path.slice(1) : path
  } catch {
    return null
  }
}

/**
 * An absolute path relative to the project's root when it lies inside it, else null. A Windows
 * root matches either separator in any case, as Windows does.
 */
function insideRoot(path: string, projectPath: string): string | null {
  const root = hostPath(projectPath).replace(/[\\/]+$/, '')
  if (!DRIVE.test(root) && !root.startsWith('\\\\')) {
    const inside = path.startsWith(root + '/') || path.startsWith(root + '\\')
    return inside ? path.slice(root.length + 1) : null
  }
  const prefix = root.replace(/\\/g, '/') + '/'
  const slashed = path.replace(/\\/g, '/')
  const inside = slashed.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
  return inside ? slashed.slice(prefix.length) : null
}

/**
 * A file reference as replies write them: `src/x.ts`, `./src/x.ts:12`, `src/x.ts:12:5`,
 * `src/x.ts#L12`, or an absolute path or a `file:` URI inside the project. Whether the file exists
 * is for the caller to check against the project's files. Null for anything else, such as a URL.
 * `link`: the text is a link's target, which may hold spaces; other text with one is no path.
 */
export function parseFileRef(text: string, projectPath: string, link = false): ParsedRef | null {
  let value = text.trim()
  if (!value || value.startsWith('#') || value.startsWith('//')) return null
  if (!link && /\s/.test(value)) return null
  if (FILE_URI.test(value)) {
    const path = fileUriPath(value)
    if (path === null) return null
    value = path
  } else {
    // A Windows drive path has a colon too, so only other schemes are URLs.
    if (SCHEME.test(value) && !DRIVE.test(value)) return null
    try {
      value = decodeURI(value)
    } catch {
      return null
    }
    if (ROOTED_DRIVE.test(value)) value = value.slice(1)
  }
  let line: number | null = null
  const suffix = LINE_SUFFIX.exec(value)
  if (suffix) {
    value = suffix[1]!
    line = Number(suffix[2] ?? suffix[3])
  }
  const absolute = value.startsWith('/') || value.startsWith('\\') || DRIVE.test(value)
  if (absolute) {
    const inside = insideRoot(value, projectPath)
    if (inside === null) return null
    value = inside
  }
  value = value.replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!value || value.endsWith('/') || value.split('/').includes('..')) return null
  return { path: value, line: line && line > 0 ? line : null, absolute }
}

/** A project file the Files pane shows rendered, whose Markdown images load from the project. */
export interface PreviewFile {
  projectPath: string
  /** Relative to the project's root, with `/`. */
  path: string
}

export const PreviewFileContext = createContext<PreviewFile | null>(null)

/**
 * The project file an image of the Markdown file `file` names, relative to the project's root with
 * `/`: a path relative to the Markdown file's folder, with `/` or `\` between segments, or an
 * absolute path or a `file:` URI inside the project. Null for anything else, such as a path that
 * climbs above the project's root; the host checks where the file really is.
 */
export function previewImagePath(written: string, file: PreviewFile): string | null {
  let value = written.trim()
  if (FILE_URI.test(value)) {
    const path = fileUriPath(value)
    if (path === null) return null
    value = path
  } else {
    if (SCHEME.test(value) && !DRIVE.test(value)) return null
    try {
      value = decodeURI(value)
    } catch {
      // A lone `%` is part of the name.
    }
    if (ROOTED_DRIVE.test(value)) value = value.slice(1)
  }
  if (/^~[\\/]/.test(value)) return null
  let segments: string[]
  if (value.startsWith('/') || value.startsWith('\\') || DRIVE.test(value)) {
    const inside = insideRoot(value, file.projectPath)
    if (inside === null) return null
    segments = inside.split(/[\\/]/)
  } else {
    segments = [...file.path.split('/').slice(0, -1), ...value.split(/[\\/]/)]
  }
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') resolved.push(segment)
    else if (resolved.pop() === undefined) return null
  }
  return resolved.length > 0 ? resolved.join('/') : null
}

/**
 * The reference when it names one of the shown project's files, else null. `link`: the text is a
 * link's target, whose full path inside the project names a file even when the project's list
 * leaves it out, as it does what git ignores, such as a build's output.
 */
export function useFileRef(
  text: string | null,
  link = false,
): (FileRef & { projectPath: string }) | null {
  const projectPath = useContext(ProjectPathContext)
  const ref = projectPath && text ? parseFileRef(text, projectPath, link) : null
  const known = useFilesStore(
    (s) => !!ref && !!projectPath && !!s.byProject[projectPath]?.known.has(ref.path),
  )
  if (!ref || !projectPath || !(known || (link && ref.absolute))) return null
  return { path: ref.path, line: ref.line, projectPath }
}

/** A file the session's agent keeps in its own folder, outside the project, as a reply links it. */
export interface AgentFileRef {
  /** Absolute on the agent's host, with `/` between segments. */
  path: string
  line: number | null
  projectPath: string
  sessionId: string
  agentId: AgentId
}

const ABSOLUTE = /^(?:\/|[a-z]:[\\/])/i

/**
 * A reference's absolute path when it lies in `folder`, the session agent's own, else null. Only
 * an absolute path or a `file:` URI names one; the host checks where it really is.
 */
export function agentFileRef(text: string, folder: string): FileRef | null {
  const value = text.trim()
  const uri = FILE_URI.test(value)
  if (!uri && !ABSOLUTE.test(value)) return null
  // With `/` on every host, which Windows takes too, so the name is the part after the last one.
  const root = folder.replace(/\\/g, '/').replace(/\/+$/, '')
  const ref = parseFileRef(uri ? value : value.replace(/\\/g, '/'), root, true)
  return ref && { path: `${root}/${ref.path}`, line: ref.line }
}

/** The reference when it names a file of the shown session's agent's own folder, else null. */
export function useAgentFileRef(text: string | null): AgentFileRef | null {
  const projectPath = useContext(ProjectPathContext)
  const sessionId = useContext(SessionIdContext)
  const agentId = useSessionsStore((s) => (sessionId ? s.byId[sessionId]?.agentId : null) ?? null)
  const named = !!text && (FILE_URI.test(text.trim()) || ABSOLUTE.test(text.trim()))
  const key = named && sessionId && agentId ? agentFolderKey(sessionId, agentId) : null
  const folder = useFilesStore((s) => (key ? s.agentFolders[key] : undefined))
  useEffect(() => {
    if (key && folder === undefined) ensureAgentFolder(sessionId!, agentId!)
  }, [key, folder, sessionId, agentId])
  if (!folder || !text || !projectPath || !sessionId || !agentId) return null
  const ref = agentFileRef(text, folder)
  return ref && { ...ref, projectPath, sessionId, agentId }
}
