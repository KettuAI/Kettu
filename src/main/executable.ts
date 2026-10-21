import { access, constants, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Platform } from '@shared/platform'

const WINDOWS_PROGRAMS = new Set(['.exe', '.com', '.cmd', '.bat'])

/** Whether a path picked in a file dialog is a program this platform can start. */
export async function isExecutableFile(path: string, platform: Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    if (platform === 'win32') return WINDOWS_PROGRAMS.has(extname(path).toLowerCase())
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
