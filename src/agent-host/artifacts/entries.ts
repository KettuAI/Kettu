// What a write to the artifacts service puts in the calling session's thread, and how those
// entries, like started sessions, git events, turn ends and the host's notices, outlive a replay.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ArtifactAction, ArtifactEntry, Patch, ThreadEntry, ThreadState } from '@shared/thread'
import type { GitEventDraft } from '../git/api'

type OwnEntry = Extract<
  ThreadEntry,
  { kind: 'artifact' | 'session_started' | 'git' | 'turn_end' | 'notice' }
>

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

/** The agent's entry before the thread's end, skipping the ones the host added itself. */
export function agentEntryBefore(thread: ThreadState): string | null {
  const { order, byId } = thread
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = byId[order[i]!]
    if (entry && !isOwn(entry)) return entry.id
  }
  return null
}

/** The entry a session another one's agent started adds to the caller's thread. */
export function startedPatch(thread: ThreadState, sessionId: string, newId: () => string): Patch {
  return {
    op: 'entry.add',
    entry: {
      kind: 'session_started',
      id: newId(),
      sessionId,
      after: agentEntryBefore(thread),
    },
  }
}

/** The entry a git event adds to a session's thread. */
export function gitPatch(thread: ThreadState, draft: GitEventDraft, newId: () => string): Patch {
  return { op: 'entry.add', entry: { ...draft, id: newId(), after: agentEntryBefore(thread) } }
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
    if (after === null && !isOwn(entry)) after = entry.id
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
 * Whether the host added the entry itself, which an agent's replay never sends again: a notice only
 * when it records `after`, as an agent's never does.
 */
function isOwn(entry: ThreadEntry): entry is OwnEntry {
  switch (entry.kind) {
    case 'artifact':
    case 'session_started':
    case 'git':
    case 'turn_end':
      return true
    case 'notice':
      return entry.after !== undefined
    default:
      return false
  }
}

/**
 * A thread's entries the host added and keeps while a replay rebuilds it, artifact entries,
 * started sessions, git events, turn ends and its own notices: each goes back after the entry it
 * followed, or, when the replay never sends that one or it recorded none, at the end of its turn,
 * counted by user messages.
 */
export class ReplayKeeper {
  private kept: { entry: OwnEntry; turn: number }[] = []
  private users = 0

  constructor(thread: ThreadState) {
    let turn = 0
    for (const id of thread.order) {
      const entry = thread.byId[id]
      if (entry?.kind === 'user') turn++
      else if (entry && isOwn(entry)) this.kept.push({ entry, turn })
    }
  }

  get empty(): boolean {
    return this.kept.length === 0
  }

  /** The kept entries that go in before this entry of the replay. */
  before(entry: ThreadEntry): OwnEntry[] {
    if (entry.kind !== 'user') return []
    const ended = this.users++
    return this.take((k) => k.turn <= ended)
  }

  /** The kept entries that go in right after this entry of the replay. */
  after(entry: ThreadEntry): OwnEntry[] {
    if (isOwn(entry)) return []
    return this.take((k) => k.entry.after === entry.id)
  }

  /** What the replay never came back to, for its end. */
  rest(): OwnEntry[] {
    return this.take(() => true)
  }

  private take(test: (kept: { entry: OwnEntry; turn: number }) => boolean): OwnEntry[] {
    const out: OwnEntry[] = []
    this.kept = this.kept.filter((k) => {
      if (!test(k)) return true
      out.push(k.entry)
      return false
    })
    return out
  }
}
