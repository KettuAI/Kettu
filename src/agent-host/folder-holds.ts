// The files that hold a folder's own config back for an `acp-folders` agent whose switch is a
// setting: Kettu's copy of the system settings the harness reads, which wins over the user's and
// the folder's own, written before each start. The user's own settings are never changed.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import type { Platform } from '@shared/platform'
import { getEnv, type Env } from './find-command'

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The system settings the harness reads now, or none where there are none or they do not read. */
async function systemSettings(file: string): Promise<Json> {
  try {
    const parsed: unknown = parseJsonc(await readFile(file, 'utf8'), [], {
      allowTrailingComma: true,
    })
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** `settings` with `value` set at `keys`, the objects on the way kept. */
function withValue(settings: Json, keys: readonly string[], value: unknown): Json {
  const [key, ...rest] = keys
  if (key === undefined) return settings
  const inner = isRecord(settings[key]) ? (settings[key] as Json) : {}
  return { ...settings, [key]: rest.length === 0 ? value : withValue(inner, rest, value) }
}

async function writePrivate(dir: string, name: string, data: unknown): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, name)
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  return file
}

function systemPath(
  env: Env,
  platform: Platform,
  variable: string,
  paths: Record<'darwin' | 'win32' | 'linux', string>,
): string {
  const set = getEnv(env, variable, platform)?.trim()
  if (set) return set
  return platform === 'darwin' ? paths.darwin : platform === 'win32' ? paths.win32 : paths.linux
}

/**
 * Qwen Code applies a folder's `.env` and settings `env` while its folder trust is off, its
 * default, so Kettu's held process turns it on, with a trust list of Kettu's own that trusts no
 * folder; the folders the user let apply run on a process with the user's own settings.
 */
export async function qwenFolderHold(
  dir: string,
  env: Env,
  platform: Platform,
): Promise<Record<string, string>> {
  const current = systemPath(env, platform, 'QWEN_CODE_SYSTEM_SETTINGS_PATH', {
    darwin: '/Library/Application Support/QwenCode/settings.json',
    win32: 'C:\\ProgramData\\qwen-code\\settings.json',
    linux: '/etc/qwen-code/settings.json',
  })
  const settings = withValue(
    await systemSettings(current),
    ['security', 'folderTrust', 'enabled'],
    true,
  )
  return {
    QWEN_CODE_SYSTEM_SETTINGS_PATH: await writePrivate(dir, 'qwen-system-settings.json', settings),
    QWEN_CODE_TRUSTED_FOLDERS_PATH: await writePrivate(dir, 'qwen-trusted-folders.json', {}),
  }
}

/**
 * Gemini CLI still takes `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT` and
 * `GOOGLE_CLOUD_LOCATION` from a folder's `.env` in a folder it does not trust, so Kettu's held
 * process ignores a folder's `.env` there; the home folder's is still read. The folders the user
 * trusts in Gemini CLI run on a process with the user's own settings.
 */
export async function geminiFolderHold(
  dir: string,
  env: Env,
  platform: Platform,
): Promise<Record<string, string>> {
  const current = systemPath(env, platform, 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', {
    darwin: '/Library/Application Support/GeminiCli/settings.json',
    win32: 'C:\\ProgramData\\gemini-cli\\settings.json',
    linux: '/etc/gemini-cli/settings.json',
  })
  const settings = withValue(await systemSettings(current), ['advanced', 'ignoreLocalEnv'], true)
  return {
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: await writePrivate(
      dir,
      'gemini-system-settings.json',
      settings,
    ),
  }
}
