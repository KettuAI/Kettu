// Claude Code's settings file in an agent's folder: read as a JSON object and written back whole,
// so what a caller does not touch stays as the user left it.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from './i18n'
import { notifyStorageWrite } from './storage'

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
    throw new Error(t('agentConfig.invalidFile', { file, format: 'JSON' }))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(t('agentConfig.notJsonObject', { file }))
  }
  return parsed as Record<string, unknown>
}

/** Writes the settings as JSON beside the file and renames it over. */
export async function writeSettings(
  file: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await writeTextAtomic(file, `${JSON.stringify(settings, null, 2)}\n`)
}

/** Writes beside the file and renames it over, so a crash never leaves half a settings file. */
export async function writeTextAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.kettu-${process.pid}.tmp`
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(temp, text, { mode: 0o600 })
    await rename(temp, file)
    notifyStorageWrite(file, true)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    notifyStorageWrite(file, false, error)
    throw error
  }
}
