import { createHash } from 'node:crypto'
import type { DeclaredHook } from '@shared/thread'
import type { FolderHooks } from '../connection'
import type { ResolvedSettings } from './sdk'

const TARGET_CHARS = 300
/** The setting sources that are the folder's own, which a cloned repository may bring. */
const FOLDER_SOURCES = new Set(['project', 'local'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The hooks the folder's own settings declare, from the sources `resolveSettings` read, or null
 * when they declare none. The digest covers each hook in full, so changing or adding one changes it.
 */
export function folderHooks(sources: ResolvedSettings['sources']): FolderHooks | null {
  const own = sources.flatMap((source) =>
    FOLDER_SOURCES.has(source.source) &&
    isRecord(source.settings.hooks) &&
    Object.keys(source.settings.hooks).length > 0
      ? [{ source: source.source, hooks: source.settings.hooks }]
      : [],
  )
  if (own.length === 0) return null
  const hooks: DeclaredHook[] = []
  for (const source of own) {
    for (const [event, groups] of Object.entries(source.hooks)) {
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
  }
  const digest = createHash('sha256').update(JSON.stringify(own)).digest('hex')
  return { hooks, digest }
}

/** The command a hook runs or the URL it calls, as the user reads it before allowing it. */
function target(hook: unknown): string {
  if (!isRecord(hook)) return ''
  const text =
    [hook.command, hook.url, hook.prompt].find((value) => typeof value === 'string') ??
    (typeof hook.type === 'string' ? hook.type : '')
  return text.length > TARGET_CHARS ? `${text.slice(0, TARGET_CHARS - 1)}…` : text
}
