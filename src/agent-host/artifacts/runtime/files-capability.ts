// `files`: the artifact's project folder, read-only, for a page the user allowed. Nothing under
// `.git`, no link that leads out of the folder, and at most 20 MiB a read.

import { realpath as realpathCallback, type Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { artifactFileType, DISK_FILE_BYTES } from '@shared/artifact-files'
import type { Platform } from '@shared/platform'
import { readBytes } from '../../files'
import { pathKey } from '../../paths'
import { CapabilityError, type CapabilityHandler } from './dispatcher'

const realpath = promisify(realpathCallback.native)

export const READ_BYTES = DISK_FILE_BYTES
export const LIST_ENTRIES = 5_000
const PATH_CHARS = 4_096
/** Reads of one artifact at once. */
const READS = 4

export interface ProjectEntry {
  name: string
  /** From the project's folder, `/`-separated. */
  path: string
  type: 'file' | 'folder'
  size: number
}

/** What is wrong with `value` as a path in the project, or null; '' is the folder itself. */
export function projectPathProblem(value: string): string | null {
  if (value === '') return null
  if (value.length > PATH_CHARS) return `is longer than ${PATH_CHARS} characters`
  if (value.startsWith('/')) return 'starts with /; give a path from the project folder'
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20 || c === 0x7f || value[i] === '\\' || value[i] === ':') {
      return 'has a backslash, a colon or a control character'
    }
  }
  for (const segment of value.split('/')) {
    if (segment === '') return 'has an empty segment'
    if (segment === '.' || segment === '..') return `has a ${segment} segment`
    if (/[. ]$/.test(segment)) return 'has a name that ends in a dot or a space'
    if (segment.toLowerCase() === '.git') return 'is inside .git, which pages may not read'
  }
  return null
}

function inside(root: string, real: string, platform: Platform): string | null {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const rootKey = pathKey(root, platform)
  const realKey = pathKey(real, platform)
  if (realKey === rootKey) return ''
  const prefix = rootKey.endsWith(paths.sep) ? rootKey : rootKey + paths.sep
  if (!realKey.startsWith(prefix)) return null
  const relative = paths.relative(root, real)
  const segments = relative.split(paths.sep)
  return segments.some((segment) => segment.toLowerCase() === '.git') ? null : segments.join('/')
}

/**
 * Where `wanted` lies once every link is followed, if that is still in the project and outside
 * `.git`; null otherwise, as for a path that does not exist.
 */
export async function resolveInProject(
  project: string,
  wanted: string,
  platform: Platform = process.platform as Platform,
): Promise<{ root: string; real: string; relative: string } | null> {
  const problem = projectPathProblem(wanted)
  if (problem) throw new CapabilityError('invalid', `The path ${problem}.`)
  const paths = platform === 'win32' ? path.win32 : path.posix
  let root: string
  let real: string
  try {
    root = await realpath(project)
    real = await realpath(wanted === '' ? root : paths.join(root, ...wanted.split('/')))
  } catch {
    return null
  }
  const relative = inside(root, real, platform)
  return relative === null ? null : { root, real, relative }
}

function notFound(wanted: string): CapabilityError {
  return new CapabilityError('not_found', `${wanted || 'The project folder'} cannot be read.`)
}

/** The entries of a folder of the project, folders first; links out of it and `.git` left out. */
export async function listProject(
  project: string,
  wanted: string,
  platform: Platform = process.platform as Platform,
): Promise<ProjectEntry[]> {
  const found = await resolveInProject(project, wanted, platform)
  if (!found) throw notFound(wanted)
  let dirents: Dirent[]
  try {
    dirents = await readdir(found.real, { withFileTypes: true })
  } catch {
    throw notFound(wanted)
  }
  const entries: ProjectEntry[] = []
  for (const dirent of dirents) {
    if (entries.length >= LIST_ENTRIES) break
    const name = dirent.name
    if (name.toLowerCase() === '.git' || projectPathProblem(name) !== null) continue
    const relative = found.relative === '' ? name : `${found.relative}/${name}`
    let target = path.join(found.real, name)
    if (dirent.isSymbolicLink()) {
      const resolved = await resolveInProject(project, relative, platform).catch(() => null)
      if (!resolved) continue
      target = resolved.real
    }
    const info = await stat(target).catch(() => null)
    if (!info || (!info.isFile() && !info.isDirectory())) continue
    entries.push({
      name,
      path: relative,
      type: info.isDirectory() ? 'folder' : 'file',
      size: info.isDirectory() ? 0 : info.size,
    })
  }
  return entries.sort(
    (a, b) =>
      (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) || a.name.localeCompare(b.name),
  )
}

/** A file of the project, at most READ_BYTES: a regular file inside it, links followed. */
export async function readProjectFile(
  project: string,
  wanted: string,
  platform: Platform = process.platform as Platform,
): Promise<Buffer> {
  if (wanted === '') throw new CapabilityError('invalid', 'Give the path of a file.')
  const found = await resolveInProject(project, wanted, platform)
  if (!found) throw notFound(wanted)
  let handle
  try {
    handle = await open(found.real, 'r')
  } catch {
    throw notFound(wanted)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new CapabilityError('invalid', `${wanted} is not a file.`)
    if (info.size > READ_BYTES) {
      throw new CapabilityError('too_large', `${wanted} is larger than 20 MiB.`)
    }
    const bytes = await readBytes(handle, info.size + 1)
    if (bytes.length > info.size) {
      throw new CapabilityError('failed', `${wanted} changed while it was read; try again.`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function filesCapability(
  platform: Platform = process.platform as Platform,
): CapabilityHandler {
  const reading = new Map<string, number>()
  const args = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const pathArg = (value: unknown, fallback?: string): string => {
    if (value === undefined && fallback !== undefined) return fallback
    if (typeof value !== 'string') throw new CapabilityError('invalid', 'path must be text.')
    return value.replace(/^\.\/+/, '').replace(/\/+$/, '')
  }
  return {
    name: 'files',
    consent: true,
    ops: ['list', 'read'],
    // An artifact under No project has no project to read.
    available: (ctx) => ctx.project !== null,
    async call(ctx, op, value) {
      const project = ctx.project
      if (project === null) throw new CapabilityError('unsupported', 'The artifact has no project.')
      const o = args(value)
      if (op === 'list') return listProject(project, pathArg(o.path, ''), platform)
      if (op !== 'read') throw new CapabilityError('unsupported', `files has no ${op}.`)
      const wanted = pathArg(o.path)
      if (o.as !== undefined && o.as !== 'text' && o.as !== 'base64') {
        throw new CapabilityError('invalid', 'as must be text or base64.')
      }
      const busy = reading.get(ctx.artifactId) ?? 0
      if (busy >= READS) {
        throw new CapabilityError('rate_limited', 'Too many reads at once; wait for some.')
      }
      reading.set(ctx.artifactId, busy + 1)
      try {
        const bytes = await readProjectFile(project, wanted, platform)
        const about = { path: wanted, size: bytes.length, type: artifactFileType(wanted) }
        if (o.as === 'base64') return { ...about, base64: bytes.toString('base64') }
        const text = utf8(bytes)
        if (text === null) {
          throw new CapabilityError('invalid', `${wanted} is not UTF-8 text; read it as bytes.`)
        }
        return { ...about, text }
      } finally {
        const left = (reading.get(ctx.artifactId) ?? 1) - 1
        if (left > 0) reading.set(ctx.artifactId, left)
        else reading.delete(ctx.artifactId)
      }
    },
  }
}
