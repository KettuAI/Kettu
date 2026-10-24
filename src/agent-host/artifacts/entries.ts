// What a write to the artifacts service puts in the calling session's thread, and how those
// entries outlive a replay.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ArtifactAction, ArtifactEntry, Patch, ThreadEntry, ThreadState } from '@shared/thread'

const ACTIONS: Record<string, ArtifactAction> = {
  create_artifact: 'create',
  update_artifact: 'update',
  restore_artifact_version: 'restore',
  delete_artifact: 'delete',
}

/** What one successful call to the service wrote. */
export interface ArtifactWrite {
  artifactId: string
  title: string
  action: ArtifactAction
  /** The version written; null for a deletion. */
  version: number | null
}

/**
 * The write a successful call made, or null for a call that only reads or that failed.
 * `titleOf` gives the artifact's title when neither the call nor its result carries it.
 */
export async function artifactWrite(
  tool: string,
  input: unknown,
  result: CallToolResult,
  titleOf: (id: string) => Promise<string | null>,
): Promise<ArtifactWrite | null> {
  const action = ACTIONS[tool]
  const out = result.structuredContent
  if (!action || result.isError || !out || typeof out.id !== 'string') return null
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const named =
    typeof out.title === 'string' ? out.title : typeof args.title === 'string' ? args.title : null
  const title = named ?? (await titleOf(out.id))
  if (title === null) return null
  return {
    artifactId: out.id,
    title,
    action,
    version: action !== 'delete' && typeof out.version === 'number' ? out.version : null,
  }
}

/** Entries the host adds itself, which an agent's replay never sends again. */
const OWN = new Set<ThreadEntry['kind']>(['notice', 'turn_end', 'git', 'artifact'])

/**
 * The patch a write makes: the latest turn's entry for the same artifact takes it, or a new entry
 * goes at the thread's end, after the call still running there.
 */
export function writePatch(thread: ThreadState, write: ArtifactWrite, newId: () => string): Patch {
  const { order, byId } = thread
  let after: string | null = null
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = byId[order[i]!]
    if (!entry) continue
    if (after === null && !OWN.has(entry.kind)) after = entry.id
    if (entry.kind === 'user') break
    if (
      write.action !== 'delete' &&
      entry.kind === 'artifact' &&
      entry.action !== 'delete' &&
      entry.artifactId === write.artifactId
    ) {
      return {
        op: 'entry.update',
        id: entry.id,
        changes: { title: write.title, version: write.version, writes: entry.writes + 1 },
      }
    }
  }
  const entry: ArtifactEntry = {
    kind: 'artifact',
    id: newId(),
    artifactId: write.artifactId,
    title: write.title,
    action: write.action,
    version: write.version,
    writes: 1,
    after,
  }
  return { op: 'entry.add', entry }
}

/**
 * A thread's artifact entries, kept while a replay rebuilds the thread: each goes back after the
 * entry it followed, or, when the replay never sends that one, at the end of its turn, counted by
 * user messages.
 */
export class ReplayKeeper {
  private kept: { entry: ArtifactEntry; turn: number }[] = []
  private users = 0

  constructor(thread: ThreadState) {
    let turn = 0
    for (const id of thread.order) {
      const entry = thread.byId[id]
      if (entry?.kind === 'user') turn++
      else if (entry?.kind === 'artifact') this.kept.push({ entry, turn })
    }
  }

  get empty(): boolean {
    return this.kept.length === 0
  }

  /** The kept entries that go in before this entry of the replay. */
  before(entry: ThreadEntry): ArtifactEntry[] {
    if (entry.kind !== 'user') return []
    const ended = this.users++
    return this.take((k) => k.turn <= ended)
  }

  /** The kept entries that go in right after this entry of the replay. */
  after(entry: ThreadEntry): ArtifactEntry[] {
    if (OWN.has(entry.kind)) return []
    return this.take((k) => k.entry.after === entry.id)
  }

  /** What the replay never came back to, for its end. */
  rest(): ArtifactEntry[] {
    return this.take(() => true)
  }

  private take(test: (kept: { entry: ArtifactEntry; turn: number }) => boolean): ArtifactEntry[] {
    const out: ArtifactEntry[] = []
    this.kept = this.kept.filter((k) => {
      if (!test(k)) return true
      out.push(k.entry)
      return false
    })
    return out
  }
}
