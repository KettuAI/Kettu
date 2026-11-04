// A file an agent names for the host to put into an artifact: read from the session's working
// folder, so its bytes never pass through the agent.

import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { readBytes } from '../files'
import { pathKey } from '../paths'

/** Why a source cannot be read: the text says what to do next. */
export class SourceError extends Error {
  constructor(
    readonly reason: 'unreadable' | 'too_large',
    message: string,
  ) {
    super(message)
    this.name = 'SourceError'
  }
}

/**
 * The bytes of `source`, a path relative to `root` or absolute: a regular file inside `root` once
 * every symbolic link is followed, of at most `limit` bytes.
 */
export async function readSource(
  root: string,
  source: string,
  limit: number,
  platform: Platform = process.platform as Platform,
): Promise<Buffer> {
  const paths = platform === 'win32' ? path.win32 : path.posix
  if (source.includes('\0')) throw new SourceError('unreadable', `${source} is not a path.`)
  let real: string
  let realRoot: string
  try {
    realRoot = await realpath(root)
    real = await realpath(paths.resolve(root, source))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new SourceError(
      'unreadable',
      code === 'ENOENT'
        ? `${source} does not exist in your working directory, ${root}.`
        : `${source} cannot be read (${code ?? (error as Error).message}).`,
    )
  }
  const rootKey = pathKey(realRoot, platform)
  const prefix = rootKey.endsWith(paths.sep) ? rootKey : rootKey + paths.sep
  if (!pathKey(real, platform).startsWith(prefix)) {
    throw new SourceError(
      'unreadable',
      `${source} is outside your working directory, ${root}; only files inside it can be used.`,
    )
  }
  let handle
  try {
    handle = await open(real, 'r')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new SourceError('unreadable', `${source} cannot be read (${code ?? 'failed'}).`)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new SourceError('unreadable', `${source} is not a regular file.`)
    if (info.size > limit) throw tooLarge(source, info.size, limit)
    // One byte past the size tells a file that grew since the stat.
    const bytes = await readBytes(handle, info.size + 1)
    if (bytes.length > info.size) {
      throw new SourceError('unreadable', `${source} changed while it was read; try again.`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

function tooLarge(source: string, size: number, limit: number): SourceError {
  const mib = (n: number): string => (n / (1024 * 1024)).toFixed(1)
  return new SourceError(
    'too_large',
    `${source} is ${mib(size)} MiB; a file from your working directory may be at most ${mib(limit)} MiB.`,
  )
}
