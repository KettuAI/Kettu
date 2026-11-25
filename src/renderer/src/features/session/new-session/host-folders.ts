// Browsing another host's folders for a project, as its own system writes them: the folders of
// one folder, its path from the root, and the folder above it. On a Windows host that lists its
// drives, a drive's root has the drives above it, as Windows' This PC.

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

/**
 * The place above a Windows host's drives, which lists them; no path of the host, and not empty,
 * since the dialog tells a parent from none by its truth.
 */
export const DRIVES = 'drives:'

/** Whether `folder` is on a drive of a Windows host, as `C:\Users`, rather than a share. */
function onDrive(folder: string, platform: Platform): boolean {
  return platform === 'win32' && /^[A-Za-z]:/.test(folder)
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

/**
 * The folders from the root down to `folder`, each with the path it opens; with `drives`, a path
 * on a drive starts at `DRIVES`, named by the dialog.
 */
export function crumbs(folder: string, platform: Platform, drives = false): Crumb[] {
  const top: Crumb = { name: '', path: DRIVES }
  if (folder === DRIVES) return [top]
  const root = rootOf(folder, platform)
  const rest = folder.slice(root.length).split(platform === 'win32' ? /[\\/]/ : '/')
  const list: Crumb[] = [{ name: root, path: root }]
  if (drives && onDrive(folder, platform)) list.unshift(top)
  let at = root
  for (const name of rest) {
    if (!name) continue
    at = joinPath(at, name, platform)
    list.push({ name, path: at })
  }
  return list
}

/** The folder above `folder`, `DRIVES` above a drive's root with `drives`, or null at the top. */
export function parentOf(folder: string, platform: Platform, drives = false): string | null {
  const list = crumbs(folder, platform, drives)
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

/** The drives `paths.drives` listed, as folders to go into. */
export function drivesOf(drives: readonly string[]): HostFolder[] {
  return drives.map((root) => ({ name: root, path: root, repo: false }))
}
