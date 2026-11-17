import { createContext, useContext, useEffect } from 'react'
import type { AgentId } from '@shared/agents'
import { relativePath } from '@renderer/lib/format'
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

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const FILE_URI = /^file:/i
const LINE_SUFFIX = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/

/** The path a `file:` URI names on this computer; null for another host's or a malformed one. */
function fileUriPath(uri: string): string | null {
  const url = URL.parse(uri)
  if (!url || (url.host !== '' && url.host !== 'localhost')) return null
  try {
    const path = decodeURIComponent(url.pathname) + url.hash
    return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path
  } catch {
    return null
  }
}

/**
 * A file reference as replies write them: `src/x.ts`, `./src/x.ts:12`, `src/x.ts:12:5`,
 * `src/x.ts#L12`, or an absolute path or a `file:` URI inside the project. Whether the file exists
 * is for the caller to check against the project's files. Null for anything else, such as a URL.
 */
export function parseFileRef(text: string, projectPath: string): FileRef | null {
  let value = text.trim()
  if (!value || /\s/.test(value) || value.startsWith('#') || value.startsWith('//')) return null
  if (FILE_URI.test(value)) {
    const path = fileUriPath(value)
    if (path === null) return null
    value = path
  } else {
    // A Windows drive path has a colon too, so only other schemes are URLs.
    if (SCHEME.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null
    try {
      value = decodeURI(value)
    } catch {
      return null
    }
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
  const ref = parseFileRef(uri ? value : value.replace(/\\/g, '/'), root)
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
