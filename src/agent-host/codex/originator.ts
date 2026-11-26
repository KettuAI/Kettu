// Keeps Kettu's honest clientInfo against official OpenAI/ChatGPT endpoints while preserving the
// native Codex CLI User-Agent prefix (via CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_cli_rs) when a
// custom model_provider or non-official base_url is active. Any non-empty override already set by
// the user is preserved untouched.

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from '@decimalturn/toml-patch'
import type { Platform } from '@shared/platform'
import { deleteEnv, getEnv, type Env } from '../find-command'
import { isObject } from '../settings-file'

export const CODEX_ORIGINATOR_ENV = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'
export const CODEX_CLI_ORIGINATOR = 'codex_cli_rs'

const OFFICIAL_PROVIDER = 'openai'

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Whether `rawUrl` targets an official OpenAI or ChatGPT HTTPS endpoint
 * (`api.openai.com`, `*.api.openai.com`, `chatgpt.com`, `*.chatgpt.com`, `chat.openai.com`).
 */
export function isOfficialOpenAIEndpoint(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  if (parsed.port !== '' && parsed.port !== '443') return false
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  return (
    host === 'api.openai.com' ||
    host.endsWith('.api.openai.com') ||
    host === 'chatgpt.com' ||
    host.endsWith('.chatgpt.com') ||
    host === 'chat.openai.com'
  )
}

/**
 * Whether the parsed `config.toml` and environment route Codex requests to a custom provider or
 * non-official base URL.
 */
export function usesCustomCodexEndpoint(
  config: Record<string, unknown>,
  env: Env,
  platform: Platform,
): boolean {
  const profileName = nonEmptyString(config.profile)
  const profiles = isObject(config.profiles) ? config.profiles : null
  const activeProfile =
    profileName && profiles && isObject(profiles[profileName]) ? profiles[profileName] : null

  const provider =
    nonEmptyString(activeProfile?.model_provider) ??
    nonEmptyString(config.model_provider) ??
    OFFICIAL_PROVIDER
  const providers = isObject(config.model_providers) ? config.model_providers : null
  const providerEntry = providers && isObject(providers[provider]) ? providers[provider] : null
  const providerBaseUrl = nonEmptyString(providerEntry?.base_url)

  if (provider !== OFFICIAL_PROVIDER) {
    return providerBaseUrl === null || !isOfficialOpenAIEndpoint(providerBaseUrl)
  }

  const openaiBaseUrl =
    nonEmptyString(activeProfile?.openai_base_url) ??
    nonEmptyString(config.openai_base_url) ??
    providerBaseUrl ??
    nonEmptyString(getEnv(env, 'OPENAI_BASE_URL', platform))
  if (openaiBaseUrl !== null && !isOfficialOpenAIEndpoint(openaiBaseUrl)) {
    return true
  }

  const chatgptBaseUrl =
    nonEmptyString(activeProfile?.chatgpt_base_url) ?? nonEmptyString(config.chatgpt_base_url)
  if (chatgptBaseUrl !== null && !isOfficialOpenAIEndpoint(chatgptBaseUrl)) {
    return true
  }

  return false
}

function mergeEnv(env: Env, specEnv: Record<string, string> | undefined, platform: Platform): Env {
  if (!specEnv || Object.keys(specEnv).length === 0) return env
  const merged: Env = { ...env }
  for (const [key, value] of Object.entries(specEnv)) {
    deleteEnv(merged, key, platform)
    merged[key] = value
  }
  return merged
}

/** Resolves the effective `CODEX_HOME` directory matching Codex's own lookup rules. */
export function resolveCodexHome(
  env: Env,
  platform: Platform,
  fallbackHome: string = os.homedir(),
  specEnv?: Record<string, string>,
): string {
  const effective = mergeEnv(env, specEnv, platform)
  const p = platform === 'win32' ? path.win32 : path.posix
  const envHome = nonEmptyString(
    getEnv(effective, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform),
  )
  const home = envHome ?? fallbackHome
  const codexHome = nonEmptyString(getEnv(effective, 'CODEX_HOME', platform))
  return codexHome ? p.resolve(home, codexHome) : p.join(home, '.codex')
}

async function readCodexConfig(file: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return {}
  }
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = parseToml(text)
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export interface CodexOriginatorOptions {
  platform: Platform
  /** Fallback home directory when the environment sets neither `CODEX_HOME` nor `HOME`/`USERPROFILE`. */
  home?: string
  /** Agent-specific variables from the launch spec that merge on top of `env` when spawning. */
  specEnv?: Record<string, string>
}

/**
 * Returns `env` with `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_cli_rs` injected when a custom
 * provider or non-official base URL is active and no user-supplied override is already set.
 */
export async function withCodexOriginator(env: Env, options: CodexOriginatorOptions): Promise<Env> {
  const { platform, specEnv } = options
  const effectiveEnv = mergeEnv(env, specEnv, platform)
  const existing = nonEmptyString(getEnv(effectiveEnv, CODEX_ORIGINATOR_ENV, platform))
  if (existing !== null) return env

  const codexHome = resolveCodexHome(effectiveEnv, platform, options.home ?? os.homedir())
  const p = platform === 'win32' ? path.win32 : path.posix
  const config = await readCodexConfig(p.join(codexHome, 'config.toml'))
  if (!usesCustomCodexEndpoint(config, effectiveEnv, platform)) return env

  const next: Env = { ...env }
  deleteEnv(next, CODEX_ORIGINATOR_ENV, platform)
  next[CODEX_ORIGINATOR_ENV] = CODEX_CLI_ORIGINATOR
  return next
}
