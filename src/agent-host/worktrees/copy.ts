// Copies a project's local files, such as `.env`, into a new worktree. Every entry is a literal
// path inside the project; nothing is read from outside the project or written outside the
// worktree, and nothing that is already there is overwritten.

import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  symlink,
} from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { HostError } from '../errors'
import { expectOk, GIT_TIMEOUT_MS, type Exec } from '../git/exec'
import { isAbsolutePath } from '../paths'
import type { CopyResult } from './api'
import { insideRoot } from './names'

export const INCLUDE_FILE = '.worktreeinclude'

/** The entries of a `.worktreeinclude`: one path per line, `#` starting a comment line. */
export function parseWorktreeInclude(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/**
 * The entry as a relative path with `/` separators, or the reason it is refused. Globs are
 * refused rather than read literally, since a user who wrote one expects it to match.
 */
export function checkIncludeEntry(
  entry: string,
  platform: Platform,
): { path: string } | { reason: string } {
  if (entry.includes('\0')) return { reason: 'contains a NUL character' }
  if (/[*?[]/.test(entry)) return { reason: 'globs are not supported' }
  const slashed = platform === 'win32' ? entry.replace(/\\/g, '/') : entry
  if (isAbsolutePath(entry, platform) || slashed.startsWith('/')) {
    return { reason: 'absolute paths are not allowed' }
  }
  // Drive-relative paths and alternate data streams.
  if (platform === 'win32' && slashed.includes(':')) return { reason: 'contains ":"' }
  const parts = slashed.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.includes('..')) return { reason: '".." is not allowed' }
  if (parts.length === 0) return { reason: 'names the project itself' }
  if (parts[0]!.toLowerCase() === '.git') return { reason: 'names git metadata' }
  return { path: parts.join('/') }
}

interface CopyContext {
  exec: Exec
  platform: Platform
  project: string
  worktree: string
  result: CopyResult
}

/** Copies what `.worktreeinclude` and `extra` name; both paths canonical. */
export async function copyLocalFiles(
  exec: Exec,
  platform: Platform,
  projectPath: string,
  worktreePath: string,
  extra: string[],
): Promise<CopyResult> {
  const p = api(platform)
  const result: CopyResult = { copied: [], skipped: [] }
  const ctx: CopyContext = { exec, platform, project: projectPath, worktree: worktreePath, result }
  const entries = [...(await readInclude(p.join(projectPath, INCLUDE_FILE))), ...extra]
  const seen = new Set<string>()
  for (const entry of entries) {
    const checked = checkIncludeEntry(entry, platform)
    if ('reason' in checked) {
      result.skipped.push({ path: entry, reason: checked.reason })
      continue
    }
    if (seen.has(checked.path)) continue
    seen.add(checked.path)
    await copyEntry(ctx, checked.path)
  }
  return result
}

async function readInclude(file: string): Promise<string[]> {
  try {
    return parseWorktreeInclude(await readFile(file, 'utf8'))
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

async function copyEntry(ctx: CopyContext, rel: string): Promise<void> {
  const source = join(ctx, ctx.project, rel)
  let real: string
  try {
    real = await realpath(source)
  } catch (error) {
    if (isMissing(error)) {
      ctx.result.skipped.push({ path: rel, reason: 'does not exist' })
      return
    }
    throw error
  }
  if (!insideRoot(ctx.project, real, ctx.platform)) {
    ctx.result.skipped.push({ path: rel, reason: 'resolves outside the project' })
    return
  }
  const tracked = await trackedFiles(ctx, rel)
  await copyNode(ctx, rel, tracked)
}

/** The files git tracks at or under `rel`, as `/`-separated paths relative to the project. */
async function trackedFiles(ctx: CopyContext, rel: string): Promise<Set<string>> {
  const result = await ctx.exec('git', ['--literal-pathspecs', 'ls-files', '-z', '--', rel], {
    cwd: ctx.project,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  try {
    expectOk('git ls-files', result)
  } catch (error) {
    throw new HostError('git_error', (error as Error).message)
  }
  return new Set(result.stdout.split('\0').filter(Boolean))
}

async function copyNode(ctx: CopyContext, rel: string, tracked: Set<string>): Promise<void> {
  const source = join(ctx, ctx.project, rel)
  const target = join(ctx, ctx.worktree, rel)
  const stats = await lstat(source)
  if (stats.isSymbolicLink()) {
    await copyLink(ctx, rel, source, target)
    return
  }
  if (stats.isDirectory()) {
    if (!(await ensureDirectory(ctx, rel))) return
    const names = await readdir(source)
    names.sort()
    for (const name of names) {
      // A nested repository's metadata is never copied.
      if (name.toLowerCase() === '.git') continue
      await copyNode(ctx, `${rel}/${name}`, tracked)
    }
    return
  }
  if (!stats.isFile()) {
    ctx.result.skipped.push({ path: rel, reason: 'not a regular file' })
    return
  }
  if (tracked.has(rel)) {
    ctx.result.skipped.push({ path: rel, reason: 'tracked by git' })
    return
  }
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (!(await ensureDirectory(ctx, parent))) return
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      ctx.result.skipped.push({ path: rel, reason: 'already exists in the worktree' })
      return
    }
    throw error
  }
  ctx.result.copied.push(rel)
}

/**
 * Recreates a link whose target lies inside the project and is written relative to it, so the
 * copy points at the worktree's own file. Any other link is skipped, never followed.
 */
async function copyLink(
  ctx: CopyContext,
  rel: string,
  source: string,
  target: string,
): Promise<void> {
  const p = api(ctx.platform)
  let resolved: string
  try {
    resolved = await realpath(source)
  } catch {
    ctx.result.skipped.push({ path: rel, reason: 'broken symbolic link' })
    return
  }
  if (!insideRoot(ctx.project, resolved, ctx.platform)) {
    ctx.result.skipped.push({ path: rel, reason: 'symbolic link to outside the project' })
    return
  }
  const text = await readlink(source)
  const lexical = p.resolve(p.dirname(target), text)
  if (isAbsolutePath(text, ctx.platform) || !insideRoot(ctx.worktree, lexical, ctx.platform)) {
    ctx.result.skipped.push({ path: rel, reason: 'symbolic link not relative to the project' })
    return
  }
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (!(await ensureDirectory(ctx, parent))) return
  try {
    await symlink(text, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      ctx.result.skipped.push({ path: rel, reason: 'already exists in the worktree' })
      return
    }
    // Windows needs a privilege or developer mode to create links.
    if (code === 'EPERM') {
      ctx.result.skipped.push({ path: rel, reason: 'symbolic links cannot be created here' })
      return
    }
    throw error
  }
  ctx.result.copied.push(rel)
}

/**
 * Makes `rel` a directory of the worktree one component at a time, so a link already in the
 * worktree, such as a tracked one, cannot take a write outside it. False when it cannot.
 */
async function ensureDirectory(ctx: CopyContext, rel: string): Promise<boolean> {
  let current = ctx.worktree
  let walked = ''
  for (const part of rel === '' ? [] : rel.split('/')) {
    walked = walked === '' ? part : `${walked}/${part}`
    current = api(ctx.platform).join(current, part)
    try {
      await mkdir(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let real: string
    try {
      real = await realpath(current)
    } catch {
      ctx.result.skipped.push({ path: rel, reason: `${walked} cannot be resolved in the worktree` })
      return false
    }
    if (!insideRoot(ctx.worktree, real, ctx.platform) || !(await lstat(real)).isDirectory()) {
      ctx.result.skipped.push({
        path: rel,
        reason: `${walked} is not a folder inside the worktree`,
      })
      return false
    }
    current = real
  }
  return true
}

function join(ctx: CopyContext, root: string, rel: string): string {
  return rel === '' ? root : api(ctx.platform).join(root, ...rel.split('/'))
}

function api(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
