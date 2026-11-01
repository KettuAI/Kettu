// Browsing another host's folders for a project, as its own system writes them: the folders of
// one folder, its path from the root, and the folder above it.

import type { Platform } from '@shared/platform'
import type { PathCompletion } from '@shared/remote/host-admin'
import { joinPath, separator } from '@renderer/web/host-path'

export interface Crumb {
  name: string
  path: string
}

export interface HostFolder {
  name: string
  path: string
  /** It holds a Git repository. */
  repo: boolean
}

/** The root a path starts at: `/`, a drive's `C:\`, or a network share's `\\server\share\`. */
function rootOf(folder: string, platform: Platform): string {
  if (platform !== 'win32') return '/'
  const drive = /^[A-Za-z]:[\\/]?/.exec(folder)
  if (drive) return `${drive[0].slice(0, 2)}\\`
  const share = /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?/.exec(folder)
  if (share) return share[0].replace(/[\\/]?$/, '\\')
  return '\\'
}

/** The folders from the root down to `folder`, each with the path it opens. */
export function crumbs(folder: string, platform: Platform): Crumb[] {
  const root = rootOf(folder, platform)
  const rest = folder.slice(root.length).split(platform === 'win32' ? /[\\/]/ : '/')
  const list: Crumb[] = [{ name: root, path: root }]
  let at = root
  for (const name of rest) {
    if (!name) continue
    at = joinPath(at, name, platform)
    list.push({ name, path: at })
  }
  return list
}

/** The folder above `folder`, or null at its root. */
export function parentOf(folder: string, platform: Platform): string | null {
  const list = crumbs(folder, platform)
  return list.length > 1 ? list.at(-2)!.path : null
}

/** What `paths.complete` asks for to list a folder's entries. */
export function listing(folder: string, platform: Platform): string {
  return folder.endsWith(separator(platform)) || (platform === 'win32' && folder.endsWith('/'))
    ? folder
    : `${folder}${separator(platform)}`
}

/** The folders a listing holds, hidden ones left out, by name. */
export function foldersOf(completion: PathCompletion, platform: Platform): HostFolder[] {
  return completion.entries
    .filter((entry) => entry.kind === 'folder' && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      path: joinPath(completion.folder, entry.name, platform),
      repo: entry.repo === true,
    }))
}
