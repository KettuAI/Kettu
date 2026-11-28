// GLM Agent's credential file (`$XDG_CONFIG_HOME/glm-acp-agent/credentials.json`): written by
// `glm-acp-agent --setup` or Kettu's API key dialog, with `Z_AI_API_KEY` in the environment taking
// precedence over the file. Kettu never retains or logs the secret value itself.

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import { getEnv, type Env } from '../find-command'
import { isObject, readSettings } from '../settings-file'
import { notifyStorageWrite } from '../storage'

/** Environment variable that overrides GLM Agent's stored credentials file. */
export const GLM_API_KEY_VAR = 'Z_AI_API_KEY'

/** Property name inside `credentials.json`, matching `glm-acp-agent/dist/llm/credentials.js`. */
const CREDENTIAL_FIELD = 'z_ai_api_key'

export type GlmCredentialSource = 'env' | 'file' | null

export interface GlmSignInState {
  signedIn: boolean
  source: GlmCredentialSource
  /** Whether a non-empty key is currently stored in `credentials.json`. */
  fileKey: boolean
}

/** Resolves `$XDG_CONFIG_HOME/glm-acp-agent/credentials.json` (default `~/.config/glm-acp-agent/credentials.json`). */
export function glmCredentialsFile(env: Env, home: string, platform: Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  const xdg = getEnv(env, 'XDG_CONFIG_HOME', platform)?.trim()
  const base = xdg ? p.resolve(home, xdg) : p.join(home, '.config')
  return p.join(base, 'glm-acp-agent', 'credentials.json')
}

/** Checks whether `credentials.json` holds a non-empty `z_ai_api_key` without exposing its value. */
export async function hasGlmFileKey(file: string): Promise<boolean> {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed)) return false
    const key = parsed[CREDENTIAL_FIELD]
    return typeof key === 'string' && key.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Inspects whether GLM Agent has credentials configured, following `glm-acp-agent`'s own
 * precedence (`Z_AI_API_KEY` env var > `credentials.json`).
 */
export async function readGlmSignInState(input: {
  env: Env
  home: string
  platform: Platform
  hasEnvKey?: boolean
}): Promise<GlmSignInState> {
  const file = glmCredentialsFile(input.env, input.home, input.platform)
  const fileKey = await hasGlmFileKey(file)
  const envValue = getEnv(input.env, GLM_API_KEY_VAR, input.platform)
  const hasEnv =
    input.hasEnvKey === true || (typeof envValue === 'string' && envValue.trim().length > 0)
  const source: GlmCredentialSource = hasEnv ? 'env' : fileKey ? 'file' : null
  return { signedIn: source !== null, source, fileKey }
}

/** Writes `credentials.json` atomically with owner-only `0600` permissions. */
async function writeCredentialsAtomic(
  file: string,
  content: Record<string, unknown>,
): Promise<void> {
  const temp = `${file}.kettu-${process.pid}-${Date.now()}.tmp`
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(temp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, file)
    notifyStorageWrite(file, true)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    notifyStorageWrite(file, false, error)
    throw error
  }
}

/** Saves `z_ai_api_key` into GLM Agent's `credentials.json`, preserving any other JSON fields. */
export async function writeGlmKey(file: string, key: string): Promise<void> {
  const current = await readSettings(file)
  await writeCredentialsAtomic(file, { ...current, [CREDENTIAL_FIELD]: key })
}

/** Removes `z_ai_api_key` from GLM Agent's `credentials.json`, deleting the file if nothing remains. */
export async function clearGlmKey(file: string): Promise<void> {
  const current = await readSettings(file)
  if (!(CREDENTIAL_FIELD in current)) return
  const next = { ...current }
  delete next[CREDENTIAL_FIELD]
  if (Object.keys(next).length === 0) {
    await rm(file, { force: true })
    notifyStorageWrite(file, true)
    return
  }
  await writeCredentialsAtomic(file, next)
}
