import { createHash } from 'node:crypto'
import type { DeclaredHook } from '@shared/thread'
import type { FolderHooks } from '../connection'
import type { ResolvedSettings } from './sdk'

const TARGET_CHARS = 300
/** The setting sources that are the folder's own, which a cloned repository may bring. */
const FOLDER_SOURCES = new Set(['project', 'local'])
/**
 * The settings whose command Claude Code runs by itself outside hooks, to get credentials or
 * telemetry headers, from the moment a session starts.
 */
const HELPER_SETTINGS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function declares(settings: Record<string, unknown>, key: string): boolean {
  const value = settings[key]
  return value !== undefined && value !== null && value !== ''
}

function ownEnv(settings: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(settings.env) && Object.keys(settings.env).length > 0 ? settings.env : null
}

/**
 * The hooks, helper commands and env the folder's own settings declare, from the sources
 * `resolveSettings` read, or null when they declare none. The digest covers each in full, so
 * changing or adding one changes it; the list names env variables without their values.
 */
export function folderHooks(sources: ResolvedSettings['sources']): FolderHooks | null {
  const own = sources.flatMap((source) => {
    if (!FOLDER_SOURCES.has(source.source)) return []
    const { settings } = source
    const hooks =
      isRecord(settings.hooks) && Object.keys(settings.hooks).length > 0 ? settings.hooks : null
    const helpers = HELPER_SETTINGS.filter((key) => declares(settings, key))
    const env = ownEnv(settings)
    if (!hooks && helpers.length === 0 && !env) return []
    // Hooks alone keep the shape their digest had before helpers and env counted, so kept answers
    // hold.
    return [
      {
        source: source.source,
        ...(hooks ? { hooks } : {}),
        ...(helpers.length > 0
          ? { helpers: Object.fromEntries(helpers.map((key) => [key, settings[key]])) }
          : {}),
        ...(env ? { env } : {}),
      },
    ]
  })
  if (own.length === 0) return null
  const hooks: DeclaredHook[] = []
  for (const source of own) {
    for (const [event, groups] of Object.entries(source.hooks ?? {})) {
      const listed = hooks.length
      for (const group of Array.isArray(groups) ? groups : []) {
        if (!isRecord(group) || !Array.isArray(group.hooks)) continue
        const matcher =
          typeof group.matcher === 'string' && group.matcher !== '' && group.matcher !== '*'
            ? group.matcher
            : null
        for (const hook of group.hooks) {
          hooks.push({ event: matcher ? `${event} (${matcher})` : event, target: target(hook) })
        }
      }
      // A shape this reads no hook from still counts, as Claude Code may read one from it.
      if (hooks.length === listed) hooks.push({ event, target: '' })
    }
    for (const [key, value] of Object.entries(source.helpers ?? {})) {
      hooks.push({
        event: key,
        target: clip(typeof value === 'string' ? value : JSON.stringify(value)),
      })
    }
  }
  // Names only: a value may be a key or a token.
  for (const name of new Set(own.flatMap((source) => Object.keys(source.env ?? {})))) {
    hooks.push({ event: 'env', target: clip(name) })
  }
  const digest = createHash('sha256').update(JSON.stringify(own)).digest('hex')
  return { hooks, digest }
}

/**
 * The env that stands in for the folder's own while it is held: each key it sets, at the value the
 * other sources give it, else the value in `env`, the environment Claude Code is started with.
 * Claude Code merges `env` by key and flag settings win, but cannot unset a key through them, so
 * one only the folder sets is empty. With the settings unread (null), no key is known.
 */
export function heldEnv(
  sources: ResolvedSettings['sources'] | null,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (!sources) return {}
  const held = new Set(
    sources.flatMap((source) =>
      FOLDER_SOURCES.has(source.source) ? Object.keys(ownEnv(source.settings) ?? {}) : [],
    ),
  )
  const others = sources.filter((source) => !FOLDER_SOURCES.has(source.source))
  return Object.fromEntries(
    [...held].map((key) => {
      const set = others.flatMap((source) => {
        const value = isRecord(source.settings.env) ? valueOf(source.settings.env, key) : undefined
        return value === undefined || value === null ? [] : [String(value)]
      })
      return [key, set.at(-1) ?? valueOf(env, key) ?? '']
    }),
  )
}

/** A variable's value; Windows names variables without regard to case. */
function valueOf<T>(record: Record<string, T>, key: string): T | undefined {
  if (Object.hasOwn(record, key)) return record[key]
  if (process.platform !== 'win32') return undefined
  const upper = key.toUpperCase()
  const found = Object.keys(record).find((name) => name.toUpperCase() === upper)
  return found === undefined ? undefined : record[found]
}

/**
 * The settings that stand in for the folder's helper commands while they are held: the user's own
 * command, or none. With the settings unread (null), every helper gives way, the user's included.
 */
export function heldHelpers(sources: ResolvedSettings['sources'] | null): Record<string, string> {
  if (!sources) return Object.fromEntries(HELPER_SETTINGS.map((key) => [key, '']))
  const user = sources.find((source) => source.source === 'user')?.settings ?? {}
  const held = HELPER_SETTINGS.filter((key) =>
    sources.some((source) => FOLDER_SOURCES.has(source.source) && declares(source.settings, key)),
  )
  // An empty command is no helper to Claude Code, which then signs in as it would without one.
  return Object.fromEntries(
    held.map((key) => [key, typeof user[key] === 'string' ? (user[key] as string) : '']),
  )
}

/** The command a hook runs or the URL it calls, as the user reads it before allowing it. */
function target(hook: unknown): string {
  if (!isRecord(hook)) return ''
  return clip(
    [hook.command, hook.url, hook.prompt].find((value) => typeof value === 'string') ??
      (typeof hook.type === 'string' ? hook.type : ''),
  )
}

function clip(text: string): string {
  return text.length > TARGET_CHARS ? `${text.slice(0, TARGET_CHARS - 1)}…` : text
}
