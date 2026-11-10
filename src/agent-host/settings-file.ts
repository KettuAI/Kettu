// Claude Code's settings file in an agent's folder: read as a JSON object and written back whole,
// so what a caller does not touch stays as the user left it.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readSettings(file: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Rewriting a file Kettu cannot read would lose what the user wrote in it.
    throw new Error(`${file} is not valid JSON; fix it or set the key there yourself`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} does not hold a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** Writes beside the file and renames it over, so a crash never leaves half a settings file. */
export async function writeSettings(
  file: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.kettu-${process.pid}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
