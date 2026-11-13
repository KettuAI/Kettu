import { create } from 'zustand'
import {
  applyPatches,
  coalescePatches,
  prependEntries,
  threadFromSnapshot,
  UnknownEntryError,
  type OlderPage,
  type PatchBatch,
  type PlanEntry,
  type SessionSnapshot,
  type ThreadEntry,
  type ThreadState,
  type UserContent,
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
  /**
   * The last older page's failure, until a page arrives: its error, how many failed in a row, and
   * when scrolling may ask again (`performance.now()` time).
   */
  olderFailure: { message: string; count: number; retryAt: number } | null
  /** The latest plan when it lies before the loaded pages. */
  plan: PlanEntry | null
}

const EMPTY: Omit<Replica, 'status'> = {
  state: null,
  seq: 0,
  error: null,
  older: null,
  loadingOlder: false,
  olderFailure: null,
  plan: null,
}

// Scrolling asks again for an older page that failed only after 2 s, doubling to a minute.
const OLDER_RETRY_MS = 2000
const OLDER_RETRY_MAX_MS = 60_000

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

type UserEntry = Extract<ThreadEntry, { kind: 'user' }>

/** A message sent from this window that the host has not put in the thread yet. */
interface Sending {
  entry: UserEntry
  text: string
  sentAt: number
  /** The thread's last entry when it was sent, if the replica was loaded. */
  after: string | null
}
const sending = new Map<string, Sending[]>()
let sendingCount = 0
// How far before the send a stored message's host time may lie and still be the send's own.
const ECHO_SKEW_MS = 10_000
let queue: PatchBatch[] = []
let frame = 0
/**
 * Each session's last batch in `queue`, which the session's next batch joins: a hidden window runs
 * no frames, so without it the queue would grow with every batch for as long as it stays hidden.
 */
const queuedLast = new Map<string, PatchBatch>()
/** Sessions whose queued patches were dropped for a snapshot, read once a frame runs. */
const resync = new Set<string>()
/** How many patches of one session wait for a frame before they give way to a snapshot. */
const MAX_QUEUED_PATCHES = 1_000

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
  if (sending.has(sessionId)) state = settleSnapshot(sessionId, state)
  setReplica(sessionId, {
    state,
    seq,
    status: 'ready',
    error: null,
    older: snapshot.older,
    loadingOlder: false,
    olderFailure: null,
    plan: snapshot.plan,
  })
}

function flush(): void {
  frame = 0
  const batches = queue
  queue = []
  queuedLast.clear()
  const resynced = [...resync]
  resync.clear()
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
      const echoes = echoesOf(batch)
      if (live) markFresh(batch, echoes)
      let state = applyPatches(replica.state, batch.patches, {
        partial: replica.older !== null,
      })
      if (sending.has(batch.sessionId)) state = settleSending(batch.sessionId, state, echoes)
      next ??= { ...replicas }
      next[batch.sessionId] = { ...replica, state, seq: batch.seq }
    } catch (error) {
      if (!(error instanceof UnknownEntryError)) console.error(error)
      refetch.add(batch.sessionId)
    }
  }

  if (next) useThreadsStore.setState({ replicas: next })
  for (const sessionId of resynced) {
    const hasState = () => Boolean(useThreadsStore.getState().replicas[sessionId]?.state)
    const inFlight = snapshotsInFlight.get(sessionId)
    if (inFlight) {
      // That snapshot may predate the dropped patches.
      void inFlight.then(() => {
        if (hasState()) void fetchSnapshot(sessionId, 'sessions.snapshot')
      })
    } else if (hasState()) {
      refetch.add(sessionId)
    }
  }
  for (const sessionId of refetch) void fetchSnapshot(sessionId, 'sessions.snapshot')
}

function markFresh(batch: PatchBatch, echoes: readonly UserEntry[]): void {
  const now = performance.now()
  for (const patch of batch.patches) {
    // A message shown while it was sending is already in view.
    if (patch.op !== 'entry.add' || echoes.includes(patch.entry as UserEntry)) continue
    let entries = fresh.get(batch.sessionId)
    if (!entries) fresh.set(batch.sessionId, (entries = new Map()))
    for (const [id, at] of entries) if (now - at >= FRESH_FOR_MS) entries.delete(id)
    entries.set(patch.entry.id, now)
  }
}

/**
 * Called for every `session.patches` event; batches are applied once per animation frame. Until
 * then a session's batches that follow each other merge into one, and past `MAX_QUEUED_PATCHES`
 * they are dropped for a snapshot, which the replica already takes after a gap.
 */
export function receiveBatch(batch: PatchBatch): void {
  const { sessionId } = batch
  if (!frame) frame = requestAnimationFrame(flush)
  // The snapshot read at the next frame holds what this batch changes.
  if (resync.has(sessionId)) return
  const last = queuedLast.get(sessionId)
  if (last && firstSeq(batch) === last.seq + 1) {
    const end = last.patches.pop()
    last.patches.push(...coalescePatches(end ? [end, ...batch.patches] : batch.patches))
    last.seq = batch.seq
    if (last.patches.length > MAX_QUEUED_PATCHES) {
      queue = queue.filter((queued) => queued.sessionId !== sessionId)
      queuedLast.delete(sessionId)
      resync.add(sessionId)
    }
    return
  }
  const own: PatchBatch = {
    sessionId,
    seq: batch.seq,
    from: firstSeq(batch),
    patches: [...batch.patches],
  }
  queue.push(own)
  queuedLast.set(sessionId, own)
}

/**
 * Loads the page before the loaded ones, for a thread scrolled back toward them, or `now` for
 * Retry; after a failure, scrolling asks again only once its wait is over. The host sends a
 * session's patches before the page, so they apply first and the page has what they changed.
 */
export function loadOlder(sessionId: string, now = false): Promise<boolean> | undefined {
  const pending = pagesInFlight.get(sessionId)
  if (pending) return pending
  const replica = useThreadsStore.getState().replicas[sessionId]
  if (!replica?.state || replica.older === null || replica.loadingOlder) return
  if (snapshotsInFlight.has(sessionId)) return
  if (!now && replica.olderFailure && performance.now() < replica.olderFailure.retryAt) return
  return requestPage(sessionId, replica, replica.older)
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
      const message = errorMessage(error)
      console.warn(`Could not load older entries of ${sessionId}: ${message}`)
      const current = useThreadsStore.getState().replicas[sessionId]
      if (current?.loadingOlder) {
        const count = (current.olderFailure?.count ?? 0) + 1
        const wait = Math.min(OLDER_RETRY_MS * 2 ** (count - 1), OLDER_RETRY_MAX_MS)
        setReplica(sessionId, {
          ...current,
          loadingOlder: false,
          olderFailure: { message, count, retryAt: performance.now() + wait },
        })
      }
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
    olderFailure: null,
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
    sending.delete(sessionId)
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
  // Asked together: the host takes them in order, so it watches before it reads the snapshot.
  const watching = host('sessions.watch', { sessionId }).catch(() => {})
  return Promise.all([watching, fetchSnapshot(sessionId, 'sessions.open')]).then(() => {})
}

/**
 * After the agent host restarts, every watched session is watched again from a new snapshot; with
 * `only`, the sessions it picks, as those on a host whose connection opened again.
 */
export function rewatchAll(only?: (sessionId: string) => boolean): void {
  for (const sessionId of watched) {
    if (only && !only(sessionId)) continue
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
  sending.delete(sessionId)
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

const textOf = (content: readonly UserContent[]) =>
  content.map((part) => (part.type === 'text' ? part.text : '')).join('')

/**
 * Shows a message the user sent at the end of the session's thread at once. The host's own entry
 * takes its place when it comes; the returned function takes it away before that, for a send that
 * failed or went to the queue.
 */
export function showSending(sessionId: string, content: UserContent[]): () => void {
  const replica = useThreadsStore.getState().replicas[sessionId]
  const order = replica?.state?.order ?? []
  const list = sending.get(sessionId) ?? []
  const item: Sending = {
    entry: { kind: 'user', id: `sending-${++sendingCount}`, content, at: Date.now() },
    text: textOf(content),
    sentAt: Date.now(),
    after: replica?.state ? (order.findLast((id) => !id.startsWith('sending-')) ?? null) : null,
  }
  list.push(item)
  sending.set(sessionId, list)
  let entries = fresh.get(sessionId)
  if (!entries) fresh.set(sessionId, (entries = new Map()))
  entries.set(item.entry.id, performance.now())
  if (replica?.state)
    setReplica(sessionId, { ...replica, state: withSending(sessionId, replica.state) })
  return () => {
    const kept = sending.get(sessionId)
    const at = kept?.indexOf(item) ?? -1
    if (!kept || at < 0) return
    kept.splice(at, 1)
    if (kept.length === 0) sending.delete(sessionId)
    const current = useThreadsStore.getState().replicas[sessionId]
    if (current?.state) {
      setReplica(sessionId, { ...current, state: withoutEntry(current.state, item.entry.id) })
    }
  }
}

/**
 * A message a person sent, which a send's entry is: from a window, or carrying this client's device
 * when the session's host is another computer or this is the web client.
 */
function isOwnMessage(entry: ThreadEntry): entry is UserEntry {
  return entry.kind === 'user' && !entry.steered && !entry.from
}

/** The batch's new messages that take the place of messages sending, oldest first. */
function echoesOf(batch: PatchBatch): UserEntry[] {
  const waiting = sending.get(batch.sessionId)?.length ?? 0
  if (waiting === 0) return []
  const echoes: UserEntry[] = []
  for (const patch of batch.patches) {
    if (patch.op === 'entry.add' && isOwnMessage(patch.entry)) echoes.push(patch.entry)
    if (echoes.length === waiting) break
  }
  return echoes
}

/** Takes away the messages `echoes` stand for, and keeps the others at the thread's end. */
function settleSending(sessionId: string, state: ThreadState, echoes: readonly UserEntry[]) {
  const list = sending.get(sessionId) ?? []
  for (const echo of echoes) {
    const text = textOf(echo.content)
    const at = list.findIndex((item) => item.text === text)
    const [gone] = list.splice(at >= 0 ? at : 0, 1)
    if (gone) state = withoutEntry(state, gone.entry.id)
  }
  if (list.length === 0) {
    sending.delete(sessionId)
    return state
  }
  return withSending(sessionId, state)
}

/** After a snapshot: the messages it holds already go, the others stay at its end. */
function settleSnapshot(sessionId: string, state: ThreadState): ThreadState {
  const list = sending.get(sessionId) ?? []
  const taken = new Set<string>()
  const echoed = (item: Sending) => {
    const start = item.after === null ? -1 : state.order.indexOf(item.after)
    for (let i = state.order.length - 1; i > start; i--) {
      const id = state.order[i]!
      const entry = state.byId[id]
      if (!entry || taken.has(id) || !isOwnMessage(entry)) continue
      if (textOf(entry.content) !== item.text) continue
      // Without the entry it followed, only a message from about the send's time is its own.
      if (start < 0 && (entry.at ?? 0) < item.sentAt - ECHO_SKEW_MS) continue
      taken.add(id)
      return true
    }
    return false
  }
  const kept = list.filter((item) => !echoed(item))
  if (kept.length === 0) {
    sending.delete(sessionId)
    return state
  }
  sending.set(sessionId, kept)
  return withSending(sessionId, state)
}

/** `state` with the messages still sending at its end, in the order they were sent. */
function withSending(sessionId: string, state: ThreadState): ThreadState {
  const list = sending.get(sessionId) ?? []
  const ids = new Set(list.map((item) => item.entry.id))
  const tail = state.order.slice(state.order.length - list.length)
  if (
    list.every((item, i) => tail[i] === item.entry.id && state.byId[item.entry.id] === item.entry)
  )
    return state
  const byId = { ...state.byId }
  for (const item of list) byId[item.entry.id] = item.entry
  return {
    ...state,
    byId,
    order: [...state.order.filter((id) => !ids.has(id)), ...list.map((item) => item.entry.id)],
  }
}

function withoutEntry(state: ThreadState, entryId: string): ThreadState {
  if (!(entryId in state.byId)) return state
  const byId = { ...state.byId }
  delete byId[entryId]
  return { ...state, byId, order: state.order.filter((id) => id !== entryId) }
}
