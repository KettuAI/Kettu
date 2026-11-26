import type { Project } from '@shared/agent-host'
import { hostOfPath, hostPath, onHost } from '@renderer/lib/host-paths'
import { projectFolders } from '@renderer/stores/projects'

export type FolderValidationError =
  | { kind: 'empty' }
  | { kind: 'notAbsolute' }
  | { kind: 'duplicate' }
  | { kind: 'otherProject'; name: string }

/** Normalizes trailing separators so `/a/b/` and `/a/b` compare as the same folder. */
export function normalizeFolderInput(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '/' || /^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed
  return trimmed.replace(/[\\/]+$/, '')
}

/** Whether a path is absolute on POSIX (`/foo`) or Windows (`C:\foo`, `\\host\share`). */
export function isAbsoluteFolderPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value)
}

function compareKey(value: string): string {
  const normalized = normalizeFolderInput(value)
  // Windows drive/UNC paths compare case-insensitively.
  if (/^[A-Za-z]:[\\/]/.test(normalized) || /^[\\/]{2}/.test(normalized)) {
    return normalized.replace(/\//g, '\\').toLowerCase()
  }
  return normalized
}

/**
 * Validates a candidate source folder being added to `project` in the Edit project dialog.
 * Returns the window-qualified folder path when valid, or a typed validation error.
 */
export function validateAdditionalFolder(
  rawInput: string,
  project: Pick<Project, 'path'>,
  currentFolders: readonly string[],
  allProjects: readonly Project[],
): { ok: true; path: string } | { ok: false; error: FolderValidationError } {
  const normalized = normalizeFolderInput(rawInput)
  if (!normalized) return { ok: false, error: { kind: 'empty' } }
  const hostId = hostOfPath(project.path)
  const rawHostPath = hostOfPath(normalized) === hostId ? hostPath(normalized) : normalized
  if (!isAbsoluteFolderPath(rawHostPath)) {
    return { ok: false, error: { kind: 'notAbsolute' } }
  }
  const qualified = hostId === null ? rawHostPath : onHost(hostId, rawHostPath)
  const targetKey = compareKey(rawHostPath)
  if (currentFolders.some((existing) => compareKey(hostPath(existing)) === targetKey)) {
    return { ok: false, error: { kind: 'duplicate' } }
  }
  for (const other of allProjects) {
    if (other.path === project.path || hostOfPath(other.path) !== hostId) continue
    if (projectFolders(other).some((folder) => compareKey(hostPath(folder)) === targetKey)) {
      return { ok: false, error: { kind: 'otherProject', name: other.name } }
    }
  }
  return { ok: true, path: qualified }
}

/** Removes a secondary folder from `folders`, refusing to remove the primary folder or last entry. */
export function removeSecondaryFolder(
  folders: readonly string[],
  primaryPath: string,
  target: string,
): string[] {
  if (folders.length <= 1 || target === primaryPath) return [...folders]
  return folders.filter((folder) => folder !== target)
}
