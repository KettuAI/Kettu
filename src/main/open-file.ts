// Opens an existing local regular file in the system's default app. Untrusted paths from the
// renderer are checked before Electron's shell.openPath runs so directories, missing files,
// network shares, and executable programs or scripts cannot be launched by mistake.

import type { Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { shell } from 'electron'
import type { Platform } from '@shared/platform'
import { getEnv, type Env } from '../agent-host/find-command'
import { t } from './i18n'

const OPEN_FILE_MAX_CHARS = 4_096
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i
const POSIX_EXEC_MASK = 0o111

// File extensions whose default OS handler executes code, launches an installer/app bundle, or
// redirects to an arbitrary target instead of opening a document in a viewer or editor.
const BLOCKED_EXTENSIONS = new Set([
  // Windows executables, scripts, installers, shortcuts, and registry/control handlers
  '.exe',
  '.com',
  '.bat',
  '.cmd',
  '.msi',
  '.msp',
  '.msu',
  '.scr',
  '.pif',
  '.vbs',
  '.vbe',
  '.jse',
  '.wsf',
  '.wsh',
  '.hta',
  '.cpl',
  '.msc',
  '.reg',
  '.lnk',
  '.ps1',
  '.psm1',
  '.psd1',
  '.appref-ms',
  '.inf',
  '.scf',
  '.gadget',
  '.application',
  // macOS app bundles, launchers, installers, scripts, and internet location shortcuts
  '.app',
  '.command',
  '.tool',
  '.action',
  '.workflow',
  '.pkg',
  '.mpkg',
  '.osx',
  '.terminal',
  '.scpt',
  '.scptd',
  '.applescript',
  '.inetloc',
  '.webloc',
  // Unix/Linux/cross-platform shell scripts, launchers, and binaries
  '.sh',
  '.bash',
  '.zsh',
  '.ksh',
  '.csh',
  '.tcsh',
  '.fish',
  '.desktop',
  '.appimage',
  '.run',
  '.bin',
  '.jar',
  '.jnlp',
  '.url',
])

// On Windows, .js defaults to Windows Script Host (wscript.exe), which executes the file directly.
const WINDOWS_EXTRA_BLOCKED_EXTENSIONS = new Set(['.js'])

export interface OpenLocalFileOptions {
  platform?: Platform
  env?: Env
  stat?(file: string): Promise<Pick<Stats, 'isFile' | 'isDirectory' | 'mode'>>
  realpath?(file: string): Promise<string>
  openPath?(file: string): Promise<string>
}

function pathApiFor(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

function isLocalAbsolutePath(value: string, platform: Platform): boolean {
  if (platform === 'win32') return WINDOWS_DRIVE_PATH.test(value)
  return value.startsWith('/') && !value.startsWith('//')
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizedExtension(file: string, platform: Platform): string {
  const cleaned = platform === 'win32' ? file.trimEnd().replace(/\.+$/, '') : file
  return pathApiFor(platform).extname(cleaned).toLowerCase()
}

function pathextSet(env: Env): Set<string> {
  const value = getEnv(env, 'PATHEXT', 'win32')
  if (!value) return new Set()
  const extensions = new Set<string>()
  for (const raw of value.split(';')) {
    const ext = raw.trim().toLowerCase()
    if (ext.startsWith('.') && ext.length > 1) extensions.add(ext)
  }
  return extensions
}

/** Whether opening `file` via the OS default handler carries an execution risk on `platform`. */
export function isBlockedExecutablePath(
  file: string,
  platform: Platform,
  env: Env = process.env,
): boolean {
  const ext = normalizedExtension(file, platform)
  if (ext === '') return false
  if (BLOCKED_EXTENSIONS.has(ext)) return true
  if (platform === 'win32') {
    if (WINDOWS_EXTRA_BLOCKED_EXTENSIONS.has(ext)) return true
    if (pathextSet(env).has(ext)) return true
  }
  return false
}

/** Validates an untrusted path argument and ensures it is a local absolute path. */
function validateLocalPath(value: unknown, platform: Platform): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > OPEN_FILE_MAX_CHARS) {
    throw new Error(`A path must be a string of 1 to ${OPEN_FILE_MAX_CHARS} characters`)
  }
  if (value.includes('\0')) throw new Error('A path must not contain a NUL character')
  if (!isLocalAbsolutePath(value, platform)) {
    throw new Error('A path must be a local absolute path')
  }
  return value
}

/**
 * Opens an existing local regular file in the system's default app.
 * Rejects relative paths, UNC/remote paths, missing paths, directories, and executable files/scripts.
 */
export async function openLocalFile(
  target: unknown,
  options: OpenLocalFileOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const statFn = options.stat ?? stat
  const realpathFn = options.realpath ?? realpath
  const openPathFn = options.openPath ?? ((file: string) => shell.openPath(file))

  const checked = validateLocalPath(target, platform)
  const pathApi = pathApiFor(platform)
  const name = pathApi.basename(checked) || checked

  let resolved: string
  try {
    resolved = await realpathFn(checked)
  } catch (error) {
    if (isMissingError(error)) {
      throw new Error(t('shell.notFound', { name }), { cause: error })
    }
    throw new Error(t('shell.openFailed', { name, reason: messageOf(error) }), { cause: error })
  }

  if (!isLocalAbsolutePath(resolved, platform)) {
    throw new Error(t('shell.notFile', { name }))
  }

  let info: Pick<Stats, 'isFile' | 'isDirectory' | 'mode'>
  try {
    info = await statFn(resolved)
  } catch (error) {
    if (isMissingError(error)) {
      throw new Error(t('shell.notFound', { name }), { cause: error })
    }
    throw new Error(t('shell.openFailed', { name, reason: messageOf(error) }), { cause: error })
  }

  if (!info.isFile()) {
    throw new Error(t('shell.notFile', { name }))
  }

  // Check both the requested path and its resolved real path so symlinks cannot disguise blocked
  // extensions, and refuse files with POSIX execute bits on macOS/Linux.
  const hasPosixExecBit = platform !== 'win32' && (info.mode & POSIX_EXEC_MASK) !== 0
  if (
    hasPosixExecBit ||
    isBlockedExecutablePath(checked, platform, env) ||
    isBlockedExecutablePath(resolved, platform, env)
  ) {
    throw new Error(t('shell.executable', { name }))
  }

  let failure: string
  try {
    failure = await openPathFn(resolved)
  } catch (error) {
    throw new Error(t('shell.openFailed', { name, reason: messageOf(error) }), { cause: error })
  }
  if (failure) {
    throw new Error(t('shell.openFailed', { name, reason: failure }))
  }
}
