// Claude Code's flag settings go to it as a file only the user can read: the SDK writes them
// inline onto its command line, which every account on the computer can read, and they may hold
// a key, a token or the address its requests go to.

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FlagSettings } from './sdk'

/** The folder of the files in Kettu's data, which the host empties as it starts. */
export function flagSettingsFolder(userDataPath: string): string {
  return path.join(userDataPath, 'claude-settings')
}

/** Writes `settings` to a new file in `dir` that only the user can read, and gives its path. */
export async function writeFlagSettings(dir: string, settings: FlagSettings): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // A folder that was already there keeps its mode otherwise.
  await chmod(dir, 0o700)
  const file = path.join(dir, `${randomUUID()}.json`)
  await writeFile(file, JSON.stringify(settings), { mode: 0o600, flag: 'wx' })
  return file
}

export async function removeFlagSettings(file: string): Promise<void> {
  await rm(file, { force: true })
}

/** Removes the files a host run left behind, as when it ended before its processes did. */
export async function clearFlagSettings(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
