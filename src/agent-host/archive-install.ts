// Installs an agent from the release archive the ACP Registry lists: downloads it into a partial
// directory, checks its SHA-256, extracts the program the registry names, and records the install
// last, so a version directory is either whole or absent. The registry ships .zip, .tar.gz and
// .tar.bz2 archives, and bare executables for a few entries, so the extraction is not the system
// `tar`, which reads neither .zip nor, without bzip2, .tar.bz2 on Linux.

import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { Platform } from '@shared/platform'
import type { AgentId } from '@shared/thread'
import {
  INSTALLED_FILE,
  PARTIAL_PREFIX,
  removeStalePartials,
  removeTree,
  renameWithRetry,
} from './adapter-install'
import { t } from './i18n'

const MIB = 1024 * 1024
/** How many bytes a download grows between two progress lines. */
const REPORT_BYTES = 4 * MIB

export interface ArchiveInstallOptions {
  /** `<userData>/agents`. */
  root: string
  agentId: AgentId
  /** The registry version; the install's folder is named after it. */
  version: string
  url: string
  /** The hash the registry gives; without one, the measured hash is recorded and warned about. */
  sha256?: string
  /** The program inside the archive, as the registry writes it. */
  cmd: string
  /** Arguments the program needs to speak ACP. */
  args?: string[]
  /** The download is the program itself, so nothing is extracted. */
  bare?: true
  platform: Platform
  timeoutMs: number
  signal?: AbortSignal
  onOutput?(text: string): void
}

/** An archive install on disk, named by its complete `installed.json`. */
export interface InstalledArchive {
  version: string
  dir: string
  url: string
  sha256: string
  cmd: string
  args: string[]
  bare?: true
  installedAt: number
}

interface ArchiveRecord {
  version: string
  url: string
  sha256: string
  cmd: string
  args?: string[]
  bare?: true
  installedAt: number
}

type Decompress = (input: string, output: string) => Promise<unknown>

function platformPath(platform: Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The absolute path of the program `cmd` names inside `dir`; an absolute or escaping one throws. */
export function programPath(dir: string, cmd: string, platform: Platform): string {
  const p = platformPath(platform)
  const program = p.resolve(dir, cmd)
  const inside = p.relative(dir, program)
  if (p.isAbsolute(cmd) || inside === '' || inside.startsWith('..') || p.isAbsolute(inside)) {
    throw new Error(t('agent.binaryInstall.programOutside', { command: cmd }))
  }
  return program
}

/** The last path segment of an archive URL, for a progress line and the page. */
function downloadName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? url) || url
  } catch {
    return url
  }
}

function formatSeconds(ms: number): string {
  return String(Math.round(ms / 100) / 10)
}

function formatSize(bytes: number): string {
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/**
 * decompress picks a format handler by name at run time, so it stays outside the bundle; a
 * bundled build cannot follow that.
 */
async function loadDecompress(): Promise<Decompress> {
  const module = (await import('decompress')) as unknown as { default?: Decompress }
  const decompress = module.default ?? (module as unknown as Decompress)
  return decompress
}

interface Download {
  sha256: string
}

/** Streams the file to disk while hashing it, so a large archive costs no second read. */
async function download(
  options: ArchiveInstallOptions,
  file: string,
  timeout: AbortSignal,
): Promise<Download> {
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  options.onOutput?.(
    `${t('agent.binaryInstall.downloadStart', { name: downloadName(options.url) })}\n`,
  )
  let response: Response
  try {
    response = await fetch(options.url, { signal, redirect: 'follow' })
  } catch (error) {
    throw downloadFailure(options, timeout, error)
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel()
    throw new Error(
      t('agent.binaryInstall.downloadFailed', {
        url: options.url,
        status: String(response.status),
      }),
    )
  }
  const hash = createHash('sha256')
  let bytes = 0
  let reported = 0
  const source = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
  source.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    bytes += chunk.length
    if (bytes - reported < REPORT_BYTES) return
    reported = bytes
    options.onOutput?.(`${t('agent.binaryInstall.downloading', { size: formatSize(bytes) })}\n`)
  })
  try {
    await pipeline(source, createWriteStream(file, { mode: 0o600 }))
  } catch (error) {
    throw downloadFailure(options, timeout, error)
  }
  const sha256 = hash.digest('hex')
  const expected = options.sha256?.toLowerCase()
  if (expected && sha256 !== expected) {
    throw new Error(t('agent.binaryInstall.hashMismatch', { expected, actual: sha256 }))
  }
  return { sha256 }
}

/** Why a download stopped: the user cancelled it, it ran past the limit, or the network failed. */
function downloadFailure(
  options: ArchiveInstallOptions,
  timeout: AbortSignal,
  error: unknown,
): Error {
  if (options.signal?.aborted) return new Error(t('agent.installStopped'))
  if (timeout.aborted) {
    return new Error(
      t('agent.binaryInstall.downloadTimedOut', {
        name: downloadName(options.url),
        seconds: formatSeconds(options.timeoutMs),
      }),
    )
  }
  const name = downloadName(options.url)
  return new Error(
    t('agent.binaryInstall.downloadError', { name, reason: (error as Error).message }),
  )
}

function isRecord(value: unknown): value is ArchiveRecord {
  const record = value as ArchiveRecord | null
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.version === 'string' &&
    typeof record.url === 'string' &&
    typeof record.sha256 === 'string' &&
    typeof record.cmd === 'string' &&
    typeof record.installedAt === 'number'
  )
}

async function readRecord(dir: string): Promise<InstalledArchive | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path.join(dir, INSTALLED_FILE), 'utf8')) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const record = parsed
  return {
    version: record.version,
    dir,
    url: record.url,
    sha256: record.sha256,
    cmd: record.cmd,
    args: Array.isArray(record.args) ? record.args : [],
    ...(record.bare ? { bare: true as const } : {}),
    installedAt: record.installedAt,
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** The archive installs for an agent, oldest first; a directory without its record is no install. */
export async function listArchiveInstalls(
  root: string,
  agentId: AgentId,
): Promise<InstalledArchive[]> {
  const agentDir = path.join(root, agentId)
  const names = await readdir(agentDir).catch(() => [] as string[])
  const found = await Promise.all(
    names
      .filter((name) => !name.startsWith(PARTIAL_PREFIX))
      .map((name) => readRecord(path.join(agentDir, name))),
  )
  return found.filter((install) => install !== null).sort((a, b) => a.installedAt - b.installedAt)
}

/**
 * Downloads and installs one archive in a partial directory, then renames it into place. A failed
 * or cancelled install deletes the directory, so nothing is left behind.
 */
export async function installArchive(options: ArchiveInstallOptions): Promise<InstalledArchive> {
  const { root, agentId } = options
  const p = platformPath(options.platform)
  const agentDir = p.join(root, agentId)
  await mkdir(agentDir, { recursive: true })
  await removeStalePartials(agentDir, options.timeoutMs)
  const partial = p.join(agentDir, `${PARTIAL_PREFIX}${randomBytes(6).toString('hex')}`)
  const file = `${partial}.download`
  const timeout = AbortSignal.timeout(options.timeoutMs)
  await mkdir(partial)
  try {
    // Refused before anything is downloaded, when the catalog names a path outside the install.
    const program = programPath(partial, options.cmd, options.platform)
    const downloaded = await download(options, file, timeout)
    if (options.signal?.aborted) throw new Error(t('agent.installStopped'))
    if (options.bare) {
      await mkdir(p.dirname(program), { recursive: true })
      await rename(file, program)
      if (options.platform !== 'win32') await chmod(program, 0o755)
    } else {
      options.onOutput?.(`${t('agent.binaryInstall.extracting')}\n`)
      const decompress = await loadDecompress()
      await decompress(file, partial)
      await rm(file, { force: true })
      if (!(await isFile(program))) {
        throw new Error(t('agent.binaryInstall.programMissing', { command: options.cmd }))
      }
    }
    if (timeout.aborted) {
      throw new Error(
        t('agent.binaryInstall.downloadTimedOut', {
          name: downloadName(options.url),
          seconds: formatSeconds(options.timeoutMs),
        }),
      )
    }
    if (options.signal?.aborted) throw new Error(t('agent.installStopped'))
    const record: ArchiveRecord = {
      version: options.version,
      url: options.url,
      sha256: downloaded.sha256,
      cmd: options.cmd,
      ...(options.args && options.args.length > 0 ? { args: options.args } : {}),
      ...(options.bare ? { bare: true as const } : {}),
      installedAt: Date.now(),
    }
    await writeFile(path.join(partial, INSTALLED_FILE), `${JSON.stringify(record, null, 2)}\n`)
    const target = p.join(agentDir, options.version)
    const existing = await stat(target).catch(() => null)
    if (existing) {
      // A complete install of this version is kept; an incomplete one is replaced.
      const current = await readRecord(target)
      if (current?.version === options.version) {
        await removeTree(partial)
        return current
      }
      await removeTree(target)
    }
    await renameWithRetry(partial, target, options.platform)
    const installed = await readRecord(target)
    if (installed?.version !== options.version) {
      throw new Error(`${options.version} is incomplete on disk.`)
    }
    return installed
  } catch (error) {
    await removeTree(partial).catch(() => {})
    await rm(file, { force: true }).catch(() => {})
    throw error
  }
}
