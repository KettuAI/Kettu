import { create } from 'zustand'
import {
  applyPatches,
  threadFromSnapshot,
  UnknownEntryError,
  type PatchBatch,
  type SessionSnapshot,
  type ThreadState,
} from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'

// The renderer's replicas of the sessions it shows. Each starts from a snapshot and applies
// patch batches in sequence order; a gap or a patch for an unknown entry refetches a snapshot.

export interface Replica {
  state: ThreadState | null // null until the first snapshot arrives
  seq: number
  status: 'loading' | 'ready' | 'error'
  error: string | null
}

interface ThreadsStore {
  replicas: Record<string, Replica>
}

export const useThreadsStore = create<ThreadsStore>()(() => ({ replicas: {} }))

/** How many recently viewed sessions stay watched, so switching back to them is instant. */
const KEEP_WATCHED = 4

const watched: string[] = [] // most recent last
const pending = new Map<string, PatchBatch[]>() // batches that arrived before their snapshot
const snapshotsInFlight = new Map<string, Promise<void>>()
const fresh = new Map<string, Set<string>>() // entries added live, which animate in once
let queue: PatchBatch[] = []
let frame = 0

/** Whether an entry arrived live rather than from a snapshot or a history replay. */
export function takeFresh(sessionId: string, entryId: string): boolean {
  const set = fresh.get(sessionId)
  if (!set?.has(entryId)) return false
  set.delete(entryId)
  return true
}

function setReplica(sessionId: string, replica: Replica): void {
  useThreadsStore.setState((s) => ({ replicas: { ...s.replicas, [sessionId]: replica } }))
}

function fetchSnapshot(
  sessionId: string,
  method: 'sessions.open' | 'sessions.snapshot',
): Promise<void> {
  const existing = snapshotsInFlight.get(sessionId)
  if (existing) return existing
  const run = host(method, { sessionId })
    .then((snapshot) => receiveSnapshot(sessionId, snapshot))
    .catch((error: unknown) => {
      const current = useThreadsStore.getState().replicas[sessionId]
      setReplica(sessionId, {
        state: current?.state ?? null,
        seq: current?.seq ?? 0,
        status: 'error',
        error: errorMessage(error),
      })
    })
    .finally(() => snapshotsInFlight.delete(sessionId))
  snapshotsInFlight.set(sessionId, run)
  return run
}

function receiveSnapshot(sessionId: string, snapshot: SessionSnapshot): void {
  let state = threadFromSnapshot(snapshot)
  let seq = snapshot.seq
  const buffered = (pending.get(sessionId) ?? []).sort((a, b) => a.seq - b.seq)
  pending.delete(sessionId)
  for (const batch of buffered) {
    if (batch.seq <= seq) continue
    if (batch.seq !== seq + 1) break
    state = applyPatches(state, batch.patches)
    seq = batch.seq
  }
  setReplica(sessionId, { state, seq, status: 'ready', error: null })
}

function flush(): void {
  frame = 0
  const batches = queue
  queue = []
  const { replicas } = useThreadsStore.getState()
  let next: Record<string, Replica> | null = null
  const refetch = new Set<string>()

  for (const batch of batches) {
    const replica = (next ?? replicas)[batch.sessionId]
    if (!replica) continue
    if (!replica.state || snapshotsInFlight.has(batch.sessionId)) {
      const list = pending.get(batch.sessionId) ?? []
      list.push(batch)
      pending.set(batch.sessionId, list)
      continue
    }
    if (batch.seq <= replica.seq) continue
    if (batch.seq !== replica.seq + 1) {
      refetch.add(batch.sessionId)
      continue
    }
    try {
      const live = replica.state.session.status !== 'starting'
      if (live) markFresh(batch)
      const state = applyPatches(replica.state, batch.patches)
      next ??= { ...replicas }
      next[batch.sessionId] = { ...replica, state, seq: batch.seq }
    } catch (error) {
      if (!(error instanceof UnknownEntryError)) console.error(error)
      refetch.add(batch.sessionId)
    }
  }

  if (next) useThreadsStore.setState({ replicas: next })
  for (const sessionId of refetch) void fetchSnapshot(sessionId, 'sessions.snapshot')
}

function markFresh(batch: PatchBatch): void {
  for (const patch of batch.patches) {
    if (patch.op !== 'entry.add') continue
    let set = fresh.get(batch.sessionId)
    if (!set) fresh.set(batch.sessionId, (set = new Set()))
    set.add(patch.entry.id)
  }
}

/** Called for every `session.patches` event; batches are applied once per animation frame. */
export function receiveBatch(batch: PatchBatch): void {
  queue.push(batch)
  if (!frame) frame = requestAnimationFrame(flush)
}

/** Shows a session: watches it, loads its replica if needed, and keeps a few recent ones live. */
export function focusSession(sessionId: string): Promise<void> {
  const at = watched.indexOf(sessionId)
  if (at >= 0) watched.splice(at, 1)
  watched.push(sessionId)
  while (watched.length > KEEP_WATCHED) {
    const dropped = watched.shift()!
    void host('sessions.unwatch', { sessionId: dropped }).catch(() => {})
    pending.delete(dropped)
    fresh.delete(dropped)
    useThreadsStore.setState((s) => {
      const replicas = { ...s.replicas }
      delete replicas[dropped]
      return { replicas }
    })
  }

  const replica = useThreadsStore.getState().replicas[sessionId]
  if (replica?.status === 'ready') {
    void host('sessions.watch', { sessionId }).catch(() => {})
    return Promise.resolve()
  }
  if (!replica) setReplica(sessionId, { state: null, seq: 0, status: 'loading', error: null })
  return host('sessions.watch', { sessionId })
    .catch(() => {})
    .then(() => fetchSnapshot(sessionId, 'sessions.open'))
}

/** After the agent host restarts, every watched session is watched again from a new snapshot. */
export function rewatchAll(): void {
  for (const sessionId of watched) {
    void host('sessions.watch', { sessionId })
      .catch(() => {})
      .then(() => fetchSnapshot(sessionId, 'sessions.snapshot'))
  }
}

export function forgetSession(sessionId: string): void {
  const at = watched.indexOf(sessionId)
  if (at >= 0) watched.splice(at, 1)
  pending.delete(sessionId)
  fresh.delete(sessionId)
  useThreadsStore.setState((s) => {
    if (!(sessionId in s.replicas)) return s
    const replicas = { ...s.replicas }
    delete replicas[sessionId]
    return { replicas }
  })
}

/** Retries opening a session whose snapshot failed. */
export function reloadSession(sessionId: string): Promise<void> {
  return fetchSnapshot(sessionId, 'sessions.open')
}
