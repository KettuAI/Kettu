// An API key the user gives an agent, handed to its harness to keep: written into the `env` of
// Claude Code's settings.json in the agent's folder, or given to `codex login --with-api-key`.
// Kettu keeps no copy and never reads one back; only the keys it writes are touched.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** What the user typed; `baseUrl` and `model` only for Claude Code. */
export interface ApiKeyInput {
  key: string
  baseUrl?: string
  model?: string
}

// The variables Claude Code reads from its settings.json `env`, as its documentation names them.
const CLAUDE_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
] as const

const MAX_KEY_CHARS = 4096
const MAX_URL_CHARS = 2048
const MAX_MODEL_CHARS = 256

/** Checks what was typed, so nothing that is not a key, a URL or a model name is written. */
export function checkApiKey(input: ApiKeyInput, allowProvider: boolean): ApiKeyInput {
  const key = input.key.trim()
  if (key.length === 0 || key.length > MAX_KEY_CHARS || /\s/.test(key)) {
    throw new Error('The API key must be one word without spaces')
  }
  const checked: ApiKeyInput = { key }
  const baseUrl = input.baseUrl?.trim()
  const model = input.model?.trim()
  if (!allowProvider && (baseUrl || model)) {
    throw new Error('This harness takes only an API key')
  }
  if (baseUrl) {
    const url = URL.parse(baseUrl)
    if (baseUrl.length > MAX_URL_CHARS || !url || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('The base URL must be an http or https address')
    }
    checked.baseUrl = baseUrl
  }
  if (model) {
    if (model.length > MAX_MODEL_CHARS || /\s/.test(model)) {
      throw new Error('The model must be one word without spaces')
    }
    checked.model = model
  }
  return checked
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
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
async function writeSettings(file: string, settings: Record<string, unknown>): Promise<void> {
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

/**
 * Sets Claude Code's variables in the settings file, keeping everything else in it. A key for
 * another provider's address goes in ANTHROPIC_AUTH_TOKEN, sent as a bearer token; Anthropic's own
 * in ANTHROPIC_API_KEY.
 */
export async function writeClaudeKey(file: string, input: ApiKeyInput): Promise<void> {
  const settings = await readSettings(file)
  const env = isObject(settings.env) ? { ...settings.env } : {}
  for (const name of CLAUDE_KEYS) delete env[name]
  if (input.baseUrl) {
    env.ANTHROPIC_BASE_URL = input.baseUrl
    env.ANTHROPIC_AUTH_TOKEN = input.key
  } else {
    env.ANTHROPIC_API_KEY = input.key
  }
  if (input.model) env.ANTHROPIC_MODEL = input.model
  await writeSettings(file, { ...settings, env })
}

/** Removes the variables `writeClaudeKey` sets, and `env` too once nothing else is in it. */
export async function clearClaudeKey(file: string): Promise<void> {
  const settings = await readSettings(file)
  if (!isObject(settings.env)) return
  const env = { ...settings.env }
  if (!CLAUDE_KEYS.some((name) => name in env)) return
  for (const name of CLAUDE_KEYS) delete env[name]
  const next = { ...settings }
  if (Object.keys(env).length > 0) next.env = env
  else delete next.env
  await writeSettings(file, next)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
