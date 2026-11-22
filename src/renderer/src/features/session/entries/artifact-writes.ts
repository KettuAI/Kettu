// The calls of Kettu's tools that write an artifact, whose cards stand for them in the thread, and
// which of an artifact's cards stands for it as it is now.

import { KETTU_SERVER, mcpCallOf } from '@shared/mcp-call'
import type { ThreadState, ToolEntry } from '@shared/thread'

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'create_artifact',
  'create_artifact_from_type',
  'update_artifact',
  'delete_artifact',
  'restore_artifact_version',
])

/** The Kettu tool a call runs, by its title; a bare name is Kettu's too, as some agents write it. */
function kettuToolOf(entry: Pick<ToolEntry, 'title'>): string | null {
  const call = mcpCallOf(entry.title)
  if (call) return call.server === KETTU_SERVER && call.direct ? call.tool : null
  return entry.title.trim()
}

/** Whether the call writes an artifact: creates, updates, deletes or restores one. */
export function isArtifactWrite(entry: Pick<ToolEntry, 'title'>): boolean {
  const tool = kettuToolOf(entry)
  return tool !== null && WRITE_TOOLS.has(tool)
}

/** The version a call of `restore_artifact_version` brought back, as its arguments name it. */
export function restoredVersionOf(entry: ToolEntry): number | null {
  if (kettuToolOf(entry) !== 'restore_artifact_version' || !entry.rawInput) return null
  try {
    const input = JSON.parse(entry.rawInput) as { version?: unknown }
    return typeof input.version === 'number' && Number.isInteger(input.version)
      ? input.version
      : null
  } catch {
    return null
  }
}

type Thread = Pick<ThreadState, 'order' | 'byId'>

// Read once per order: an entry's kind and artifact never change after it is added, so only a new
// entry, which makes a new order, changes the answer.
const lastEntries = new WeakMap<readonly string[], Map<string, string>>()

/** Whether the entry is its artifact's last in the thread, the one a running turn writes to. */
export function isLastArtifactEntry(thread: Thread, entryId: string): boolean {
  const entry = thread.byId[entryId]
  if (entry?.kind !== 'artifact') return false
  let last = lastEntries.get(thread.order)
  if (!last) {
    last = new Map()
    for (const id of thread.order) {
      const each = thread.byId[id]
      if (each?.kind === 'artifact') last.set(each.artifactId, each.id)
    }
    lastEntries.set(thread.order, last)
  }
  return last.get(entry.artifactId) === entryId
}
