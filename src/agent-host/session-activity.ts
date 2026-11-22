// What a session's main thread runs now, for its summary: the tool calls still running, each with
// when it started, so the summary changes as a call starts or ends and never with its output.

import type { SessionActivity } from '@shared/agent-host'
import type { Patch, ThreadState, ToolEntry } from '@shared/thread'

const DETAIL_CHARS = 200

// The changes to a running call that can change what the summary says of it.
const SHOWN: ReadonlySet<string> = new Set(['status', 'title', 'toolKind', 'rawInput', 'locations'])

function running(entry: ToolEntry): boolean {
  return entry.status === 'pending' || entry.status === 'in_progress'
}

function clip(text: string): string {
  return text.length > DETAIL_CHARS ? `${text.slice(0, DETAIL_CHARS - 1)}…` : text
}

function inputField(raw: string | undefined, keys: readonly string[]): string | null {
  if (!raw || !raw.startsWith('{')) return null
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof input !== 'object' || input === null) return null
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** A call's key argument: a command's first line, a file, a search's words or an address. */
export function activityDetail(entry: ToolEntry): string | null {
  let detail: string | null
  switch (entry.toolKind) {
    case 'execute': {
      const command = inputField(entry.rawInput, ['command', 'cmd']) ?? entry.rawInput ?? null
      detail =
        command
          ?.split('\n')
          .find((line) => line.trim())
          ?.trim() ?? null
      break
    }
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
      detail = entry.locations[0]?.path ?? inputField(entry.rawInput, ['file_path', 'path'])
      break
    case 'search':
      detail = inputField(entry.rawInput, ['pattern', 'query', 'q', 'regex'])
      break
    case 'fetch':
      detail = inputField(entry.rawInput, ['url', 'query'])
      break
    default:
      detail = null
  }
  return detail ? clip(detail) : null
}

export class ToolActivity {
  // By entry id, in the order the calls started.
  private readonly started = new Map<string, number>()

  /** Follows one patch the thread took; true when what the summary says may have changed. */
  follow(thread: ThreadState, patch: Patch, now: number): boolean {
    switch (patch.op) {
      case 'entry.add': {
        const { entry } = patch
        if (entry.kind !== 'tool' || !running(entry)) return false
        this.started.delete(entry.id)
        this.started.set(entry.id, now)
        return true
      }
      case 'entry.update': {
        const entry = thread.byId[patch.id]
        if (entry?.kind !== 'tool') return false
        const known = this.started.has(entry.id)
        if (!running(entry)) {
          if (!known) return false
          this.started.delete(entry.id)
          return true
        }
        if (!known) {
          this.started.set(entry.id, now)
          return true
        }
        return Object.keys(patch.changes).some((key) => SHOWN.has(key))
      }
      case 'thread.reset':
        // A replay brings back the calls that ran before; only calls that start from now on show.
        if (this.started.size === 0) return false
        this.started.clear()
        return true
      case 'thread.truncate': {
        const gone = [...this.started.keys()].filter((id) => !(id in thread.byId))
        for (const id of gone) this.started.delete(id)
        return gone.length > 0
      }
      default:
        return false
    }
  }

  /** The latest call to start of those still running, or null for none. */
  current(thread: ThreadState): SessionActivity | null {
    const ids = [...this.started.keys()]
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]!
      const entry = thread.byId[id]
      if (entry?.kind !== 'tool' || !running(entry)) continue
      return {
        entryId: id,
        toolKind: entry.toolKind,
        title: entry.title,
        detail: activityDetail(entry),
        startedAt: this.started.get(id)!,
      }
    }
    return null
  }

  /** The turn ended or the session closed: nothing runs. */
  clear(): void {
    this.started.clear()
  }
}
