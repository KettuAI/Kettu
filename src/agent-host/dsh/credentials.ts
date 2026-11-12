// DeepSeek Harness's own credential file, `.credentials.yaml` in its home: which route the agent
// signs in on, and the API key Kettu hands it to keep. Kettu keeps no copy; it writes only
// `refs.DEEPSEEK_API_KEY` and leaves what else the file holds as it was.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isMap, parseDocument } from 'yaml'
import type { Env } from '../find-command'

export const API_KEY = 'DEEPSEEK_API_KEY'
const FILE = '.credentials.yaml'
/** The record dsh's DeepSeek account sign-in stores its grant under. */
const ACCOUNT_RECORD = 'deepseek-account-platform/default'

export type Provider = 'deepseek-account' | 'deepseek-official'

/** The agent's dsh home: its `DSH_HOME`, else `~/.dsh`. */
export function dshHome(env: Env): string {
  const moved = env.DSH_HOME?.trim()
  return moved ? path.resolve(os.homedir(), moved) : path.join(os.homedir(), '.dsh')
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** The file's `refs` and `records`, as far as it reads; nothing for a file it cannot parse. */
function sections(text: string | null): {
  refs: Record<string, unknown>
  records: Record<string, unknown>
} {
  if (!text) return { refs: {}, records: {} }
  const value = parseDocument(text).toJS() as unknown
  if (typeof value !== 'object' || value === null) return { refs: {}, records: {} }
  const { refs, records } = value as { refs?: unknown; records?: unknown }
  const object = (part: unknown): Record<string, unknown> =>
    typeof part === 'object' && part !== null && !Array.isArray(part)
      ? (part as Record<string, unknown>)
      : {}
  return { refs: object(refs), records: object(records) }
}

/** Whether a dotenv file names the key, without reading its value. */
function namesKey(text: string | null): boolean {
  return !!text && new RegExp(`^\\s*(?:export\\s+)?${API_KEY}\\s*=\\s*\\S`, 'm').test(text)
}

/**
 * The route the agent signs in on: its DeepSeek account when dsh stored one, its API key when one
 * is set anywhere dsh looks, or null when neither is.
 */
export async function readProvider(env: Env, cwd?: string): Promise<Provider | null> {
  const home = dshHome(env)
  const { refs, records } = sections(await readText(path.join(home, FILE)))
  if (ACCOUNT_RECORD in records) return 'deepseek-account'
  if (typeof refs[API_KEY] === 'string' && refs[API_KEY] !== '') return 'deepseek-official'
  if (env[API_KEY]?.trim()) return 'deepseek-official'
  if (namesKey(await readText(path.join(home, '.env')))) return 'deepseek-official'
  if (cwd && namesKey(await readText(path.join(cwd, '.env')))) return 'deepseek-official'
  return null
}

/** The key the file holds, read for the one request that shows its balance and never kept. */
export async function readApiKey(env: Env): Promise<string | null> {
  const { refs } = sections(await readText(path.join(dshHome(env), FILE)))
  const stored = refs[API_KEY]
  if (typeof stored === 'string' && stored !== '') return stored
  return env[API_KEY]?.trim() || null
}

/** Sets or removes the key in the file, keeping the rest; the file stays readable by its owner alone. */
async function changeKey(home: string, key: string | null): Promise<void> {
  const file = path.join(home, FILE)
  const text = await readText(file)
  const doc = parseDocument(text ?? 'version: 1\n')
  if (text !== null && doc.errors.length > 0) {
    throw new Error(`${file} is not valid YAML; fix it or remove the key there`)
  }
  if (!isMap(doc.contents)) {
    if (key === null) return
    throw new Error(`${file} does not hold a credential map`)
  }
  if (key === null) {
    if (!doc.hasIn(['refs', API_KEY])) return
    doc.deleteIn(['refs', API_KEY])
  } else {
    if (!doc.has('version')) doc.set('version', 1)
    doc.setIn(['refs', API_KEY], key)
  }
  await mkdir(home, { recursive: true, mode: 0o700 })
  // Written beside it and moved over, so dsh never reads half a file.
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, doc.toString(), { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, file)
}

export function writeApiKey(home: string, key: string): Promise<void> {
  return changeKey(home, key)
}

export function clearApiKey(home: string): Promise<void> {
  return changeKey(home, null)
}
