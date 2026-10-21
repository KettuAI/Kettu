// Finds a command on Windows without the working-directory-first search of CreateProcess,
// so a git.exe inside a repository is never run in place of the installed one.

import { stat } from 'node:fs/promises'
import { win32 } from 'node:path'

export type IsFile = (path: string) => Promise<boolean>

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

// Node refuses to start .bat and .cmd files without a shell, and the service never uses one.
const RUNNABLE_EXTENSIONS = ['.com', '.exe']

function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/**
 * Looks `name` up in the directories of `PATH`, trying the extensions of `PATHEXT` that can
 * be started directly, and returns the full path or null. Relative `PATH` entries are skipped.
 */
export async function findWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  isFile: IsFile = isRegularFile,
): Promise<string | null> {
  const pathext = (variable(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
  const extensions = RUNNABLE_EXTENSIONS.filter((extension) => pathext.includes(extension))
  const hasExtension = RUNNABLE_EXTENSIONS.includes(win32.extname(name).toLowerCase())
  const suffixes = hasExtension ? [''] : extensions

  const directories = win32.isAbsolute(name)
    ? ['']
    : (variable(env, 'PATH') ?? '')
        .split(';')
        .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter((entry) => entry !== '' && win32.isAbsolute(entry))
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = directory === '' ? name + suffix : win32.join(directory, name + suffix)
      if (await isFile(candidate)) return candidate
    }
  }
  return null
}
