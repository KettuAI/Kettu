import { create } from 'zustand'
import {
  applyPatches,
  prependEntries,
  threadFromSnapshot,
  UnknownEntryError,
  type OlderPage,
  type PatchBatch,
  type PlanEntry,
  type SessionSnapshot,
  type ThreadState,
} from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'

// The renderer's replicas of the sessions it shows. Each starts from a snapshot of the latest
// page of the thread, takes older pages as the thread scrolls back, and applies patch batches in
// sequence order; a gap or a patch for an unknown entry refetches a snapshot.

export interface Replica {
  state: ThreadState | null // null until the first snapshot arrives
  seq: number
  status: 'loading' | 'ready' | 'error'
  error: string | null
  /** The cursor for the page before the loaded ones, or null once the thread's start is loaded. */
  older: number | null
  loadingOlder: boolean
  /** The latest plan when it lies before the loaded pages. */
  plan: PlanEntry | null
}

const EMPTY: Omit<Replica, 'status'> = {
  state: null,
  seq: 0,
  error: null,
  older: null,
  loadingOlder: false,
  plan: null,
}

interface ThreadsStore {
  replicas: Record<string, Replica>
}

export const useThreadsStore = create<ThreadsStore>()(() => ({ replicas: {} }))

/** How many recently viewed sessions stay watched, so switching back to them is instant. */
const KEEP_WATCHED = 4

const watched: string[] = [] // most recent last
// The sessions the split shows, folded panes included; they stay watched however many there are.
let pinned: string[] = []
const pending = new Map<string, PatchBatch[]>() // batches that arrived before their snapshot
const snapshotsInFlight = new Map<string, Promise<void>>()
const pagesInFlight = new Map<string, Promise<boolean>>()
// Entries added live, with when they arrived; they animate in once, on their first render.
const fresh = new Map<string, Map<string, number>>()
const FRESH_FOR_MS = 1000
let queue: PatchBatch[] = []
let frame = 0

/**
 * Whether an entry arrived live in the last second rather than from a snapshot or a history
 * replay. It is a time window rather than a one-time flag so StrictMode's double render and a
 * remount agree.
 */
export function isFresh(sessionId: string, entryId: string): boolean {
  const at = fresh.get(sessionId)?.get(entryId)
  return at !== undefined && performance.now() - at < FRESH_FOR_MS
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
  const current = useThreadsStore.getState().replicas[sessionId]
  // A replica that holds older pages keeps them: the snapshot reaches back as far as it does.
  const request =
    method === 'sessions.snapshot' && current?.state
      ? host(method, { sessionId, from: current.older ?? 0 })
      : host(method, { sessionId })
  const run = request
    .then((snapshot) => receiveSnapshot(sessionId, snapshot))
    .catch((error: unknown) => {
      const latest = useThreadsStore.getState().replicas[sessionId]
      setReplica(sessionId, {
        ...EMPTY,
        ...latest,
        loadingOlder: false,
        status: 'error',
        error: errorMessage(error),
      })
    })
    .finally(() => snapshotsInFlight.delete(sessionId))
  snapshotsInFlight.set(sessionId, run)
  return run
}

/** The first seq a batch covers: its own, or the first of those it merges. */
function firstSeq(batch: PatchBatch): number {
  return batch.from ?? batch.seq
}

function receiveSnapshot(sessionId: string, snapshot: SessionSnapshot): void {
  let state = threadFromSnapshot(snapshot)
  let seq = snapshot.seq
  const buffered = (pending.get(sessionId) ?? []).sort((a, b) => a.seq - b.seq)
  pending.delete(sessionId)
  const partial = snapshot.older !== null
  for (const batch of buffered) {
    if (batch.seq <= seq) continue
    if (firstSeq(batch) !== seq + 1) break
    state = applyPatches(state, batch.patches, { partial })
    seq = batch.seq
  }
  setReplica(sessionId, {
    state,
    seq,
    status: 'ready',
    error: null,
    older: snapshot.older,
    loadingOlder: false,
    plan: snapshot.plan,
  })
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
    if (firstSeq(batch) !== replica.seq + 1) {
      refetch.add(batch.sessionId)
      continue
    }
    try {
      const live = replica.state.session.status !== 'starting'
      if (live) markFresh(batch)
      const state = applyPatches(replica.state, batch.patches, {
        partial: replica.older !== null,
      })
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
  const now = performance.now()
  for (const patch of batch.patches) {
    if (patch.op !== 'entry.add') continue
    let entries = fresh.get(batch.sessionId)
    if (!entries) fresh.set(batch.sessionId, (entries = new Map()))
    for (const [id, at] of entries) if (now - at >= FRESH_FOR_MS) entries.delete(id)
    entries.set(patch.entry.id, now)
  }
}

/** Called for every `session.patches` event; batches are applied once per animation frame. */
export function receiveBatch(batch: PatchBatch): void {
  queue.push(batch)
  if (!frame) frame = requestAnimationFrame(flush)
}

/**
 * Loads the page before the loaded ones, for a thread scrolled back toward them. The host sends
 * a session's patches before the page, so they apply first and the page has what they changed.
 */
export function loadOlder(sessionId: string): void {
  const replica = useThreadsStore.getState().replicas[sessionId]
  if (!replica?.state || replica.older === null || replica.loadingOlder) return
  if (snapshotsInFlight.has(sessionId)) return
  void requestPage(sessionId, replica, replica.older)
}

/**
 * Loads everything back to the position `pos` in one request, for a jump to an entry the replica
 * does not hold yet. False when a page failed or the replica went away.
 */
export async function loadThrough(sessionId: string, pos: number): Promise<boolean> {
  for (;;) {
    const waiting = snapshotsInFlight.get(sessionId) ?? pagesInFlight.get(sessionId)
    if (waiting) {
      await waiting
      continue
    }
    const replica = useThreadsStore.getState().replicas[sessionId]
    if (!replica?.state) return false
    if (replica.older === null || replica.older <= pos) return true
    if (!(await requestPage(sessionId, replica, replica.older, pos))) return false
  }
}

/** Requests the page before `before`, or back to `from`; resolves with whether it arrived. */
function requestPage(
  sessionId: string,
  replica: Replica,
  before: number,
  from?: number,
): Promise<boolean> {
  setReplica(sessionId, { ...replica, loadingOlder: true })
  const run = host(
    'sessions.page',
    from === undefined ? { sessionId, before } : { sessionId, before, from },
  )
    .then((page) => {
      receivePage(sessionId, before, page)
      return true
    })
    .catch((error: unknown) => {
      console.warn(`Could not load older entries of ${sessionId}: ${errorMessage(error)}`)
      const current = useThreadsStore.getState().replicas[sessionId]
      if (current?.loadingOlder) setReplica(sessionId, { ...current, loadingOlder: false })
      return false
    })
    .finally(() => pagesInFlight.delete(sessionId))
  pagesInFlight.set(sessionId, run)
  return run
}

function receivePage(sessionId: string, before: number, page: OlderPage): void {
  if (frame) {
    cancelAnimationFrame(frame)
    flush()
  }
  const replica = useThreadsStore.getState().replicas[sessionId]
  // A snapshot replaced the replica while the page was on its way.
  if (!replica?.state || replica.older !== before) return
  setReplica(sessionId, {
    ...replica,
    state: prependEntries(replica.state, page.entries),
    older: page.older,
    loadingOlder: false,
  })
}

/** The sessions the split holds, which stay watched besides the few recent others. */
export function keepWatched(sessionIds: readonly string[]): void {
  const next = [...sessionIds]
  if (next.length === pinned.length && next.every((id, i) => id === pinned[i])) return
  pinned = next
  for (const sessionId of next) if (!watched.includes(sessionId)) void focusSession(sessionId)
  dropUnwatched()
}

/** Drops the sessions watched only as recent ones past the last few; the layout's stay. */
function dropUnwatched(): void {
  const recent = watched.filter((sessionId) => !pinned.includes(sessionId))
  const dropped = new Set(recent.slice(0, Math.max(0, recent.length - KEEP_WATCHED)))
  for (let i = watched.length - 1; i >= 0; i--) {
    const sessionId = watched[i]!
    if (!dropped.has(sessionId)) continue
    watched.splice(i, 1)
    void host('sessions.unwatch', { sessionId }).catch(() => {})
    pending.delete(sessionId)
    fresh.delete(sessionId)
    useThreadsStore.setState((s) => {
      const replicas = { ...s.replicas }
      delete replicas[sessionId]
      return { replicas }
    })
  }
}

/** Shows a session: watches it, loads its replica if needed, and keeps a few recent ones live. */
export function focusSession(sessionId: string): Promise<void> {
  const at = watched.indexOf(sessionId)
  if (at >= 0) watched.splice(at, 1)
  watched.push(sessionId)
  dropUnwatched()

  const replica = useThreadsStore.getState().replicas[sessionId]
  if (replica?.status === 'ready') {
    void host('sessions.watch', { sessionId }).catch(() => {})
    return Promise.resolve()
  }
  if (!replica) setReplica(sessionId, { ...EMPTY, status: 'loading' })
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
