// `paths.complete`: what a device typing a path on the host is offered, the entries of the folder
// the typed path's last part is in that start with it. It only reads, and lists nothing where the
// folder cannot be read. `paths.drives`: the drives of a Windows host, to go up past a drive's root.

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { PathCompletion } from '@shared/remote/host-admin'
import { isExecutableFile } from '../main/executable'
import { isAbsolutePath } from './paths'

/** The most entries one completion lists. */
export const MAX_COMPLETIONS = 200

/** How long a drive may take to answer before it counts as not ready, as a lost network drive. */
export const DRIVE_WAIT_MS = 2_000

type Kind = PathCompletion['entries'][number]['kind']

function api(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** `~` alone or followed by a separator, which stands for the home folder. */
export function isHomePath(value: string, platform: Platform): boolean {
  return (
    value === '~' || value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))
  )
}

/** A path a completion takes: absolute, or under the home folder. */
export function isCompletablePath(value: string, platform: Platform): boolean {
  return isAbsolutePath(value, platform) || isHomePath(value, platform)
}

async function kindOf(file: string): Promise<Kind | null> {
  try {
    const info = await stat(file)
    if (info.isDirectory()) return 'folder'
    return info.isFile() ? 'file' : null
  } catch {
    return null
  }
}

/** The completions of `typed`, which `isCompletablePath` accepts. */
export async function completePath(
  typed: string,
  platform: Platform,
  home: string,
): Promise<PathCompletion> {
  const p = api(platform)
  const written = isHomePath(typed, platform) ? home + typed.slice(1) : typed
  const separators = platform === 'win32' ? /[\\/]/ : /\//
  let cut = written.length
  while (cut > 0 && !separators.test(written[cut - 1]!)) cut--
  const folder = p.resolve(written.slice(0, cut) || p.sep)
  const start = written.slice(cut)
  const fold = (name: string): string => (platform === 'win32' ? name.toLowerCase() : name)
  const wanted = fold(start)

  const found = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const matching = found.filter(
    ({ name }) => fold(name).startsWith(wanted) && (start.startsWith('.') || !name.startsWith('.')),
  )
  const typedEntries = await Promise.all(
    matching.map(async (entry) => {
      // A link is what it points at; one that points nowhere is left out.
      const kind: Kind | null = entry.isDirectory()
        ? 'folder'
        : entry.isFile()
          ? 'file'
          : entry.isSymbolicLink()
            ? await kindOf(p.join(folder, entry.name))
            : null
      return kind ? { name: entry.name, kind } : null
    }),
  )
  const listed = typedEntries
    .filter((entry) => entry !== null)
    .sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
    )
    .slice(0, MAX_COMPLETIONS)
  const runnable = (name: string): Promise<boolean> =>
    isExecutableFile(p.join(folder, name), platform)
  // A repository's `.git` is a folder, or a file in a worktree or a submodule.
  const repo = async (name: string): Promise<boolean> =>
    (await kindOf(p.join(folder, name, '.git'))) !== null
  const entries = await Promise.all(
    listed.map(async ({ name, kind }) =>
      kind === 'folder'
        ? { name, kind, executable: false, repo: await repo(name) }
        : { name, kind, executable: await runnable(name) },
    ),
  )

  const exactKind = await kindOf(p.resolve(written))
  const exact = exactKind
    ? {
        kind: exactKind,
        executable: exactKind === 'file' && (await isExecutableFile(p.resolve(written), platform)),
      }
    : null
  return { folder, entries, exact }
}

/**
 * The drives of a Windows host that answer now, by their roots (`C:\`), in letter order; one
 * without its disc, a network drive that is not connected or one too slow to answer is left out.
 * Other systems have one root and list none.
 */
export async function listDrives(
  platform: Platform,
  read: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
): Promise<string[]> {
  if (platform !== 'win32') return []
  const roots = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`)
  const ready = await Promise.all(roots.map((root) => answers(read, root)))
  return roots.filter((_, i) => ready[i])
}

async function answers(
  read: (path: string) => Promise<{ isDirectory(): boolean }>,
  root: string,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), DRIVE_WAIT_MS)
  })
  const found = read(root).then(
    (info) => info.isDirectory(),
    () => false,
  )
  try {
    return await Promise.race([found, late])
  } finally {
    clearTimeout(timer)
  }
}
