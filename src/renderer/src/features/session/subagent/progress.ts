import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SessionSummary } from '@shared/agent-host'
import type { StopReason, ThreadEntry, ToolEntry } from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'
import { secondsTime, subscribeSeconds } from '@renderer/lib/use-now'
import { focusSession, useThreadsStore } from '@renderer/stores/threads'

/** A sub-agent's tool call, as its block lists it. */
export type SubagentStep = Pick<
  ToolEntry,
  'id' | 'status' | 'toolKind' | 'title' | 'locations' | 'rawInput'
> & {
  /** It waits for the user's answer. */
  waiting: boolean
}

/** What a sub-agent's thread says about its work. */
export interface SubagentDigest {
  steps: SubagentStep[]
  /** Its tool calls; null while the start of its thread is not loaded. */
  tools: number | null
  /** How long its latest run took, from that run's end. */
  durationMs: number | null
  stopReason: StopReason | null
  canCancel: boolean
}

export interface SubagentProgress {
  /** Its tool calls; null when unknown without loading its thread. */
  tools: number | null
  /** How long it has run, or ran; null when unknown. */
  elapsedMs: number | null
  running: boolean
}

export function subagentRunning(child: Pick<SessionSummary, 'status'>): boolean {
  return (
    child.status === 'running' ||
    child.status === 'awaiting_permission' ||
    child.status === 'starting'
  )
}

/** The digest of a sub-agent's entries; `complete` when they reach back to its thread's start. */
export function digestOf(
  entries: readonly (ThreadEntry | undefined)[],
  complete: boolean,
  canCancel: boolean,
): SubagentDigest {
  const steps: SubagentStep[] = []
  let durationMs: number | null = null
  let stopReason: StopReason | null = null
  for (const entry of entries) {
    if (entry?.kind === 'tool') {
      steps.push({
        id: entry.id,
        status: entry.status,
        toolKind: entry.toolKind,
        title: entry.title,
        locations: entry.locations.slice(0, 1),
        ...(entry.rawInput === undefined ? {} : { rawInput: entry.rawInput }),
        waiting: entry.permission !== null,
      })
    } else if (entry?.kind === 'turn_end') {
      durationMs = entry.durationMs
      stopReason = entry.stopReason
    }
  }
  return { steps, tools: complete ? steps.length : null, durationMs, stopReason, canCancel }
}

/**
 * Tool count and time: while it runs, the time since it started, unless its thread shows an
 * earlier run, whose start the summary does not keep; once it ends, its latest run's length.
 */
export function progressOf(
  child: Pick<SessionSummary, 'status' | 'createdAt'>,
  digest: SubagentDigest | null,
  now: number,
): SubagentProgress {
  const running = subagentRunning(child)
  let elapsedMs: number | null
  if (running) {
    elapsedMs = digest?.durationMs != null ? null : Math.max(0, now - child.createdAt)
  } else {
    elapsedMs = digest?.durationMs ?? null
  }
  return { tools: digest?.tools ?? null, elapsedMs, running }
}

// One read of a finished sub-agent's thread, kept by its status and update time: its parent's
// thread lists it as a block, which needs its tool calls without watching its thread.
interface Read {
  key: string
  digest: SubagentDigest
}

const READS_KEPT = 100
const reads = new Map<string, Read>()
const reading = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function subscribeReads(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const readKey = (child: Pick<SessionSummary, 'status' | 'updatedAt'>): string =>
  `${child.status}:${child.updatedAt}`

/** Reads a sub-agent's whole thread once, unless the read kept for its state is current. */
export function readSubagent(
  child: Pick<SessionSummary, 'id' | 'status' | 'updatedAt'>,
): Promise<void> {
  const key = readKey(child)
  if (reads.get(child.id)?.key === key) return Promise.resolve()
  const pending = reading.get(child.id)
  if (pending) return pending
  const run = host('sessions.snapshot', { sessionId: child.id, from: 0 })
    .then((snapshot) => {
      reads.delete(child.id)
      reads.set(child.id, {
        key,
        digest: digestOf(
          snapshot.entries,
          snapshot.older === null,
          snapshot.session.subagent?.canCancel ?? false,
        ),
      })
      // The oldest read goes first: a Map keeps the order of insertion.
      for (const id of reads.keys()) {
        if (reads.size <= READS_KEPT) break
        reads.delete(id)
      }
      for (const listener of listeners) listener()
    })
    .catch((error: unknown) => {
      console.warn(`Could not read sub-agent ${child.id}: ${errorMessage(error)}`)
    })
    .finally(() => reading.delete(child.id))
  reading.set(child.id, run)
  return run
}

/** The digest of a sub-agent's thread: its replica's when one is loaded, else the read kept. */
export function useSubagentDigest(childId: string | undefined): SubagentDigest | null {
  const replica = useThreadsStore((s) => (childId ? s.replicas[childId] : undefined))
  const read = useSyncExternalStore(subscribeReads, () =>
    childId ? reads.get(childId) : undefined,
  )
  return useMemo(() => {
    const state = replica?.state
    if (state) {
      return digestOf(
        state.order.map((id) => state.byId[id]),
        replica.older === null,
        state.session.subagent?.canCancel ?? false,
      )
    }
    return read?.digest ?? null
  }, [replica, read])
}

const noSubscribe = () => () => {}
const noTime = () => 0

/** `progressOf` for a digest, the time ticking each second while the sub-agent runs. */
export function useProgressOf(
  child: Pick<SessionSummary, 'status' | 'createdAt'> | undefined,
  digest: SubagentDigest | null,
): SubagentProgress {
  const ticking = !!child && subagentRunning(child)
  const now = useSyncExternalStore(
    ticking ? subscribeSeconds : noSubscribe,
    ticking ? secondsTime : noTime,
  )
  if (!child) return { tools: digest?.tools ?? null, elapsedMs: null, running: false }
  return progressOf(child, digest, now)
}

/**
 * A sub-agent's tool count and time, as far as what is loaded tells: its block in the parent's
 * thread loads its thread while in view, and the sidebar reads the same numbers.
 */
export function useSubagentProgress(child: SessionSummary): SubagentProgress {
  return useProgressOf(child, useSubagentDigest(child.id))
}

/**
 * Loads what a sub-agent's block shows while it is in view or open: a running one's thread is
 * watched, so its steps arrive as they happen; a finished one's is read once.
 */
export function useLoadSubagent(
  child: SessionSummary | undefined,
  { open, visible }: { open: boolean; visible: boolean },
): void {
  const id = child?.id
  const running = !!child && subagentRunning(child)
  const wanted = open || visible
  const loaded = useThreadsStore((s) => (id ? !!s.replicas[id] : false))
  const status = child?.status
  const updatedAt = child?.updatedAt

  // Once per change, never again when the replica goes: blocks in view would otherwise take
  // turns pushing each other out of the few sessions kept watched.
  useEffect(() => {
    if (id && wanted && running) void focusSession(id)
  }, [id, wanted, running])

  useEffect(() => {
    if (!id || !status || updatedAt === undefined || !wanted || running || loaded) return
    void readSubagent({ id, status, updatedAt })
  }, [id, status, updatedAt, wanted, running, loaded])
}
