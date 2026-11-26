// Pure helpers for locating project files on the current or a remote host.

import { hostOfPath, hostPath } from '@renderer/lib/host-paths'

const ABSOLUTE = /^(?:[\\/]|[a-z]:[\\/])/i
const DRIVE = /^[a-z]:/i
const TILDE = /^~(?:$|[\\/])/

export interface ResolvedFilePath {
  /** Absolute path as the project's host writes it, or null when unexpanded or escaping root. */
  absolutePath: string | null
  /** Path relative to the project root using `/`, or null when outside the project. */
  relativePath: string | null
}

/** Whether `projectPath` is on this computer and reachable by local editors and the file manager. */
export function isLocalProject(projectPath: string, web: boolean): boolean {
  return !web && hostOfPath(projectPath) === null
}

/** Whether `path` is already rooted (POSIX `/`, Windows drive, or UNC), excluding `~` paths. */
export function isAbsolutePath(path: string): boolean {
  return ABSOLUTE.test(path)
}

/** A path of the project as its host writes it, joined with the separator the host uses. */
export function hostFilePath(projectPath: string, path: string): string {
  const root = hostPath(projectPath)
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return path === '' ? root : `${root.replace(/[\\/]+$/, '')}${sep}${path.split('/').join(sep)}`
}

function normalizeRelative(path: string): string | null {
  const segments: string[] = []
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.pop() === undefined) return null
    } else {
      segments.push(segment)
    }
  }
  return segments.length > 0 ? segments.join('/') : null
}

/**
 * `path` relative to `root` with `/` separators when it lies inside `root`, else null. Handles
 * POSIX, Windows (case-insensitive, mixed separators), and `kettu-host:` qualified roots.
 */
export function relativeToRoot(path: string, root: string): string | null {
  if (!path || TILDE.test(path)) return null
  if (!isAbsolutePath(path)) return normalizeRelative(path)
  const cleanRoot = hostPath(root).replace(/[\\/]+$/, '')
  const cleanPath = hostPath(path)
  const windows = cleanRoot.includes('\\') || DRIVE.test(cleanRoot)
  const slashedRoot = cleanRoot.replace(/\\/g, '/')
  const slashedPath = cleanPath.replace(/\\/g, '/')
  const prefix = slashedRoot === '' ? '/' : `${slashedRoot}/`
  const inside = windows
    ? slashedPath.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
    : slashedPath.startsWith(prefix)
  if (!inside) return null
  return normalizeRelative(slashedPath.slice(prefix.length))
}

/** Resolves a diff or tool path into its host absolute path and project-relative path. */
export function resolveFilePath(projectPath: string, path: string): ResolvedFilePath {
  if (!path || TILDE.test(path)) return { absolutePath: null, relativePath: null }
  const relative = relativeToRoot(path, projectPath)
  if (relative !== null) {
    return { absolutePath: hostFilePath(projectPath, relative), relativePath: relative }
  }
  return {
    absolutePath: isAbsolutePath(path) ? hostPath(path) : null,
    relativePath: null,
  }
}
