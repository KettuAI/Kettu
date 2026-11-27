import { create } from 'zustand'
import {
  applyPatches,
  coalescePatches,
  hasToolDigest,
  prependEntries,
  threadFromSnapshot,
  UnknownEntryError,
  type ContentRef,
  type OlderPage,
  type Patch,
  type PatchBatch,
  type PlanEntry,
  type SessionSnapshot,
  type SessionStatus,
  type ThreadEntry,
  type ThreadState,
  type UserContent,
} from '@shared/thread'
import { errorMessage, host, sessionHost } from '@renderer/lib/host'
import { useWebHostStore } from '@renderer/stores/web-host'
import { forgetOutline, invalidateOutlines } from '@renderer/features/session/outline/outline-cache'

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
const KEEP_WATCHED_DESKTOP = 4
const KEEP_WATCHED_WEB = 1
const isWebClient = (): boolean =>
  typeof window !== 'undefined' &&
  (window as { kettu?: { client?: string } }).kettu?.client === 'web'
const keepWatchedLimit = (): number => (isWebClient() ? KEEP_WATCHED_WEB : KEEP_WATCHED_DESKTOP)

const watched: string[] = [] // most recent last
// The sessions the split shows, folded panes included; they stay watched however many there are.
let pinned: string[] = []
const pending = new Map<string, PatchBatch[]>() // batches that arrived before their snapshot
const pendingOverflow = new Set<string>()
const snapshotsInFlight = new Map<string, Promise<void>>()
const pagesInFlight = new Map<string, Promise<boolean>>()
const entriesInFlight = new Map<string, Promise<void>>()
// Entries added live, with when they arrived; they animate in once, on their first render.
const fresh = new Map<string, Map<string, number>>()
const FRESH_FOR_MS = 1000

type UserEntry = Extract<ThreadEntry, { kind: 'user' }>

/** A message sent from this window that the host has not put in the thread yet. */
interface Sending {
  entry: UserEntry
  sentAt: number
  /** The thread's last real entry when it was sent, if the replica was loaded. */
  after: string | null
  /** True when the replica was loaded and held no real entries yet at send time. */
  empty: boolean
  /** The suggestion cleared optimistically when this send started, for failure rollback. */
  clearedSuggestion: string | null
  /** True once the host updates suggestion or leaves idle, preventing stale rollback. */
  suggestionSuperseded: boolean
}
const sending = new Map<string, Sending[]>()
let sendingCount = 0

/** An in-flight send without an optimistic entry (such as an agent switch) that hides the old suggestion. */
interface SuggestionHold {
  clearedSuggestion: string | null
  superseded: boolean
}
const suggestionHolds = new Map<string, Set<SuggestionHold>>()
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
/** Cap on distinct queued batches across sessions while frames are paused (e.g., background tabs). */
const MAX_QUEUED_BATCHES = 256
/** Cap on buffered batches waiting behind an in-flight snapshot for one session. */
const MAX_PENDING_BATCHES = 128

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
  const overflowed = pendingOverflow.delete(sessionId)
  const buffered = (pending.get(sessionId) ?? []).sort((a, b) => a.seq - b.seq)
  pending.delete(sessionId)
  const partial = snapshot.older !== null
  for (const batch of buffered) {
    if (batch.seq <= seq) continue
    if (firstSeq(batch) !== seq + 1) break
    state = applyPatches(state, batch.patches, { partial })
    seq = batch.seq
  }
  if (sending.has(sessionId) || suggestionHolds.has(sessionId)) {
    markSupersededFromSnapshot(sessionId, state)
  }
  if (sending.has(sessionId)) state = settleSnapshot(sessionId, state)
  if (suggestionHolds.has(sessionId)) state = withClearedSuggestion(state)
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
  if (overflowed) {
    queueMicrotask(() => {
      if (useThreadsStore.getState().replicas[sessionId]?.state) {
        void fetchSnapshot(sessionId, 'sessions.snapshot')
      }
    })
  }
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
      if (pendingOverflow.has(batch.sessionId)) continue
      const list = pending.get(batch.sessionId) ?? []
      if (list.length >= MAX_PENDING_BATCHES) {
        pending.delete(batch.sessionId)
        pendingOverflow.add(batch.sessionId)
        continue
      }
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
      const resets = batch.patches.some((patch) => patch.op === 'thread.reset')
      if (sending.has(batch.sessionId) || suggestionHolds.has(batch.sessionId)) {
        markSupersededFromPatches(batch.sessionId, batch.patches)
      }
      let state = applyPatches(replica.state, batch.patches, {
        partial: replica.older !== null,
      })
      if (resets) {
        if (sending.has(batch.sessionId)) state = settleSnapshot(batch.sessionId, state)
        if (suggestionHolds.has(batch.sessionId)) state = withClearedSuggestion(state)
      } else {
        const matched = matchBatchEchoes(batch)
        if (live) markFresh(batch, matched.entries)
        if (sending.has(batch.sessionId)) {
          state = applySettledSending(batch.sessionId, state, matched, batch.patches)
        } else if (suggestionHolds.has(batch.sessionId)) {
          state = withClearedSuggestion(state)
        }
      }
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

function dropQueuedFor(sessionId: string): void {
  if (queuedLast.delete(sessionId)) {
    queue = queue.filter((queued) => queued.sessionId !== sessionId)
  }
}

function markFresh(batch: PatchBatch, echoes: ReadonlySet<UserEntry>): void {
  const now = performance.now()
  for (const patch of batch.patches) {
    // A message shown while it was sending is already in view.
    if (patch.op !== 'entry.add' || echoes.has(patch.entry as UserEntry)) continue
    let entries = fresh.get(batch.sessionId)
    if (!entries) fresh.set(batch.sessionId, (entries = new Map()))
    for (const [id, at] of entries) if (now - at >= FRESH_FOR_MS) entries.delete(id)
    entries.set(patch.entry.id, now)
  }
}

/**
 * Called for every `session.patches` event; batches are applied once per animation frame. Until
 * then a session's batches that follow each other merge into one, and past `MAX_QUEUED_PATCHES`
 * (or on sequence gaps / global queue pressure) they are dropped for a snapshot, which the replica
 * already takes after a gap.
 */
export function receiveBatch(batch: PatchBatch): void {
  const { sessionId } = batch
  if (!frame) frame = requestAnimationFrame(flush)
  // The snapshot read at the next frame holds what this batch changes.
  if (resync.has(sessionId)) return
  const last = queuedLast.get(sessionId)
  if (last) {
    if (batch.seq <= last.seq) return
    if (firstSeq(batch) === last.seq + 1) {
      const end = last.patches.pop()
      last.patches.push(...coalescePatches(end ? [end, ...batch.patches] : batch.patches))
      last.seq = batch.seq
      if (last.patches.length > MAX_QUEUED_PATCHES) {
        dropQueuedFor(sessionId)
        resync.add(sessionId)
      }
      return
    }
    // A sequence gap already requires a snapshot on flush; drop stale queued patches now.
    dropQueuedFor(sessionId)
    resync.add(sessionId)
    return
  }
  if (batch.patches.length > MAX_QUEUED_PATCHES || queue.length >= MAX_QUEUED_BATCHES) {
    resync.add(sessionId)
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

function clearSessionBuffers(sessionId: string): void {
  pending.delete(sessionId)
  pendingOverflow.delete(sessionId)
  fresh.delete(sessionId)
  sending.delete(sessionId)
  resync.delete(sessionId)
  dropQueuedFor(sessionId)
}

/**
 * Reads a full tool entry from the host when the page received a digested summary
 * (`TOOL_DIGESTS_FEATURE`), deduplicating concurrent reads for the same entry.
 */
export function loadFullEntry(sessionId: string, entryId: string): Promise<void> {
  const current = useThreadsStore.getState().replicas[sessionId]?.state?.byId[entryId]
  if (!hasToolDigest(current)) return Promise.resolve()
  const key = `${sessionId}\0${entryId}`
  const existing = entriesInFlight.get(key)
  if (existing) return existing
  const run = host('sessions.entry', { sessionId, entryId })
    .then((full) => {
      const replica = useThreadsStore.getState().replicas[sessionId]
      const latest = replica?.state?.byId[entryId]
      if (!replica?.state || !latest || latest.kind !== 'tool' || full.kind !== 'tool') return
      const merged: ThreadEntry = {
        ...full,
        // Keep fresher live status/permission fields if a patch arrived while loading.
        status: latest.status,
        permission: latest.permission,
        permissionResult: latest.permissionResult,
      }
      setReplica(sessionId, {
        ...replica,
        state: {
          ...replica.state,
          byId: { ...replica.state.byId, [entryId]: merged },
        },
      })
    })
    .finally(() => entriesInFlight.delete(key))
  entriesInFlight.set(key, run)
  return run
}

/** Drops the sessions watched only as recent ones past the last few; the layout's stay. */
function dropUnwatched(): void {
  const recent = watched.filter((sessionId) => !pinned.includes(sessionId))
  const dropped = new Set(recent.slice(0, Math.max(0, recent.length - keepWatchedLimit())))
  for (let i = watched.length - 1; i >= 0; i--) {
    const sessionId = watched[i]!
    if (!dropped.has(sessionId)) continue
    watched.splice(i, 1)
    void host('sessions.unwatch', { sessionId }).catch(() => {})
    clearSessionBuffers(sessionId)
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
  invalidateOutlines(only)
  for (const sessionId of watched) {
    if (only && !only(sessionId)) continue
    forgetOutline(sessionId)
    void host('sessions.watch', { sessionId })
      .catch(() => {})
      .then(() => fetchSnapshot(sessionId, 'sessions.snapshot'))
  }
}

export function forgetSession(sessionId: string): void {
  const at = watched.indexOf(sessionId)
  if (at >= 0) watched.splice(at, 1)
  clearSessionBuffers(sessionId)
  suggestionHolds.delete(sessionId)
  forgetOutline(sessionId)
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

function refsOf(content: readonly UserContent[]): ContentRef[] {
  const refs: ContentRef[] = []
  for (const part of content) {
    if (part.type === 'ref') refs.push(part.ref)
  }
  return refs
}

function sameRef(a: ContentRef, b: ContentRef): boolean {
  switch (a.kind) {
    case 'attachment':
      if (b.kind !== 'attachment') return false
      if (a.attachment.id && b.attachment.id) return a.attachment.id === b.attachment.id
      return a.attachment.type === b.attachment.type && a.attachment.name === b.attachment.name
    case 'image':
      if (b.kind !== 'image' || a.mimeType !== b.mimeType) return false
      if ('blob' in a && 'blob' in b) return a.blob === b.blob
      if ('data' in a && 'data' in b) return a.data === b.data
      return true
    case 'audio':
      return (
        b.kind === 'audio' && a.mimeType === b.mimeType && a.size === b.size && a.name === b.name
      )
    case 'video':
      return (
        b.kind === 'video' && a.mimeType === b.mimeType && a.size === b.size && a.name === b.name
      )
    case 'link':
      return b.kind === 'link' && a.uri === b.uri && a.name === b.name
    case 'terminal':
      return b.kind === 'terminal' && a.terminalId === b.terminalId
    case 'page':
      return b.kind === 'page' && a.tabId === b.tabId
    case 'device':
      return b.kind === 'device' && a.deviceId === b.deviceId
    case 'plugin':
      return (
        b.kind === 'plugin' &&
        a.pluginId === b.pluginId &&
        a.source === b.source &&
        a.item === b.item
      )
    case 'unsupported':
      return b.kind === 'unsupported' && a.label === b.label
  }
}

/**
 * Whether a host user entry carries the same text and attachment/ref fingerprint as an optimistic
 * send, allowing host-enriched fields such as expanded slash commands, settled attachment metadata,
 * or stored image blobs.
 */
function sameContent(a: readonly UserContent[], b: readonly UserContent[]): boolean {
  if (textOf(a) !== textOf(b)) return false
  const refsA = refsOf(a)
  const refsB = refsOf(b)
  if (refsA.length !== refsB.length) return false
  return refsA.every((ref, i) => sameRef(ref, refsB[i]!))
}

function isIdleStatus(status: SessionStatus): boolean {
  return status === 'ready' || status === 'closed'
}

function hasPendingSend(sessionId: string): boolean {
  return (
    (sending.get(sessionId)?.length ?? 0) > 0 || (suggestionHolds.get(sessionId)?.size ?? 0) > 0
  )
}

function withClearedSuggestion(state: ThreadState): ThreadState {
  if (state.session.suggestion == null) return state
  return { ...state, session: { ...state.session, suggestion: null } }
}

function withRestoredSuggestion(
  sessionId: string,
  state: ThreadState,
  previous: string | null,
  superseded: boolean,
): ThreadState {
  if (
    previous === null ||
    superseded ||
    hasPendingSend(sessionId) ||
    state.session.suggestion != null ||
    !isIdleStatus(state.session.status)
  ) {
    return state
  }
  return { ...state, session: { ...state.session, suggestion: previous } }
}

function markSupersededFromPatches(sessionId: string, patches: readonly Patch[]): void {
  const supersedes = patches.some(
    (patch) =>
      patch.op === 'session.update' &&
      ('suggestion' in patch.changes ||
        (patch.changes.status !== undefined && !isIdleStatus(patch.changes.status))),
  )
  if (!supersedes) return
  for (const item of sending.get(sessionId) ?? []) item.suggestionSuperseded = true
  for (const hold of suggestionHolds.get(sessionId) ?? []) hold.superseded = true
}

function markSupersededFromSnapshot(sessionId: string, state: ThreadState): void {
  const idle = isIdleStatus(state.session.status)
  const reported = state.session.suggestion ?? null
  for (const item of sending.get(sessionId) ?? []) {
    if (!idle || reported !== item.clearedSuggestion) item.suggestionSuperseded = true
  }
  for (const hold of suggestionHolds.get(sessionId) ?? []) {
    if (!idle || reported !== hold.clearedSuggestion) hold.superseded = true
  }
}

function hasSuggestionAfter(patches: readonly Patch[], index: number): boolean {
  let latest: string | null | undefined
  for (let i = index + 1; i < patches.length; i++) {
    const patch = patches[i]!
    if (patch.op === 'session.update' && 'suggestion' in patch.changes) {
      latest = patch.changes.suggestion
    }
  }
  return latest != null
}

/**
 * Optimistically clears the session's next-message suggestion while a send without an optimistic
 * thread entry (such as an agent switch) is in flight. Call the returned function with `true`
 * when the send fails to restore the cleared suggestion if it was not superseded meanwhile.
 */
export function suppressSuggestion(sessionId: string): (restore?: boolean) => void {
  const replica = useThreadsStore.getState().replicas[sessionId]
  const hold: SuggestionHold = {
    clearedSuggestion: replica?.state?.session.suggestion ?? null,
    superseded: false,
  }
  let holds = suggestionHolds.get(sessionId)
  if (!holds) suggestionHolds.set(sessionId, (holds = new Set()))
  holds.add(hold)
  if (replica?.state && replica.state.session.suggestion != null) {
    setReplica(sessionId, { ...replica, state: withClearedSuggestion(replica.state) })
  }
  return (restore = false) => {
    const currentHolds = suggestionHolds.get(sessionId)
    if (!currentHolds?.delete(hold)) return
    if (currentHolds.size === 0) suggestionHolds.delete(sessionId)
    if (!restore) return
    const current = useThreadsStore.getState().replicas[sessionId]
    if (!current?.state) return
    const next = withRestoredSuggestion(
      sessionId,
      current.state,
      hold.clearedSuggestion,
      hold.superseded,
    )
    if (next !== current.state) setReplica(sessionId, { ...current, state: next })
  }
}

/**
 * Shows a message the user sent at the end of the session's thread at once and clears any stale
 * next-message suggestion on the replica. The host's own entry takes its place when it comes; the
 * returned function takes it away before that, for a send that failed or went to the queue.
 */
export function showSending(
  sessionId: string,
  content: UserContent[],
): (options?: { restoreSuggestion?: boolean }) => void {
  const replica = useThreadsStore.getState().replicas[sessionId]
  const order = replica?.state?.order ?? []
  const after = replica?.state ? (order.findLast((id) => !id.startsWith('sending-')) ?? null) : null
  const list = sending.get(sessionId) ?? []
  const item: Sending = {
    entry: { kind: 'user', id: `sending-${++sendingCount}`, content, at: Date.now() },
    sentAt: Date.now(),
    after,
    empty: Boolean(replica?.state) && after === null,
    clearedSuggestion: replica?.state?.session.suggestion ?? null,
    suggestionSuperseded: false,
  }
  list.push(item)
  sending.set(sessionId, list)
  let entries = fresh.get(sessionId)
  if (!entries) fresh.set(sessionId, (entries = new Map()))
  entries.set(item.entry.id, performance.now())
  if (replica?.state)
    setReplica(sessionId, { ...replica, state: withSending(sessionId, replica.state) })
  return (options) => {
    const kept = sending.get(sessionId)
    const at = kept?.indexOf(item) ?? -1
    if (!kept || at < 0) return
    kept.splice(at, 1)
    if (kept.length === 0) sending.delete(sessionId)
    const current = useThreadsStore.getState().replicas[sessionId]
    if (current?.state) {
      let next = withoutEntry(current.state, item.entry.id)
      if (options?.restoreSuggestion) {
        next = withRestoredSuggestion(
          sessionId,
          next,
          item.clearedSuggestion,
          item.suggestionSuperseded,
        )
      }
      setReplica(sessionId, { ...current, state: next })
    }
  }
}

/**
 * A message a person sent from this client: unmarked from a local window, or carrying `device`
 * when this is the web client (matching this browser's device id once welcomed) or the session lives
 * on another host. Excludes agent-to-agent (`from`), card approvals, and Kettu system messages, and
 * includes `steered` echoes so an optimistic sending entry never leaks if a host delivers a
 * follow-up as steered.
 */
function isOwnMessage(sessionId: string, entry: ThreadEntry): entry is UserEntry {
  if (entry.kind !== 'user' || entry.from || entry.approval || entry.kettu) return false
  if (isWebClient()) {
    if (!entry.device) return false
    const ownDeviceId = useWebHostStore.getState().host?.device.id ?? null
    return ownDeviceId === null || entry.device.id === ownDeviceId
  }
  if (sessionHost(sessionId) !== null) return Boolean(entry.device)
  return !entry.device
}

interface MatchedEchoes {
  entries: Set<UserEntry>
  settledIds: string[]
  remaining: Sending[]
  /** Index of the last patch in the batch that matched a pending optimistic send, or -1. */
  lastEchoIndex: number
}

const NO_ECHOES: MatchedEchoes = {
  entries: new Set(),
  settledIds: [],
  remaining: [],
  lastEchoIndex: -1,
}

/**
 * Matches the batch's new user entries against pending optimistic sends, oldest first. Scans until
 * every pending send has matched so an unrelated message earlier in the batch never hides a real
 * echo that follows it.
 */
function matchBatchEchoes(batch: PatchBatch): MatchedEchoes {
  const list = sending.get(batch.sessionId)
  if (!list || list.length === 0) return NO_ECHOES
  const remaining = [...list]
  const entries = new Set<UserEntry>()
  const settledIds: string[] = []
  let lastEchoIndex = -1
  for (let i = 0; i < batch.patches.length; i++) {
    const patch = batch.patches[i]!
    if (patch.op !== 'entry.add' || !isOwnMessage(batch.sessionId, patch.entry)) continue
    const echo = patch.entry
    const at = remaining.findIndex((item) => sameContent(item.entry.content, echo.content))
    if (at < 0) continue
    const [gone] = remaining.splice(at, 1)
    if (gone) {
      entries.add(echo)
      settledIds.push(gone.entry.id)
      lastEchoIndex = i
    }
    if (remaining.length === 0) break
  }
  return { entries, settledIds, remaining, lastEchoIndex }
}

/** Takes away the optimistic entries `matched` settled, and keeps the others at the thread's end. */
function applySettledSending(
  sessionId: string,
  state: ThreadState,
  matched: MatchedEchoes,
  patches: readonly Patch[],
): ThreadState {
  for (const id of matched.settledIds) state = withoutEntry(state, id)
  if (matched.remaining.length === 0) {
    sending.delete(sessionId)
    if (
      matched.lastEchoIndex >= 0 &&
      state.session.suggestion != null &&
      !hasSuggestionAfter(patches, matched.lastEchoIndex)
    ) {
      state = withClearedSuggestion(state)
    }
    if (suggestionHolds.has(sessionId)) state = withClearedSuggestion(state)
    return state
  }
  sending.set(sessionId, matched.remaining)
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
      if (!entry || taken.has(id) || !isOwnMessage(sessionId, entry)) continue
      if (!sameContent(item.entry.content, entry.content)) continue
      // Without the entry it followed (and when the thread already had history), only a message
      // from about the send's time is its own.
      if (start < 0 && !item.empty && (entry.at ?? 0) < item.sentAt - ECHO_SKEW_MS) continue
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
  const clearSuggestion = list.length > 0 && state.session.suggestion != null
  const ids = new Set(list.map((item) => item.entry.id))
  const tail = state.order.slice(state.order.length - list.length)
  const entriesUnchanged = list.every(
    (item, i) => tail[i] === item.entry.id && state.byId[item.entry.id] === item.entry,
  )
  if (entriesUnchanged && !clearSuggestion) return state
  const session = clearSuggestion ? { ...state.session, suggestion: null } : state.session
  if (entriesUnchanged) return { ...state, session }
  const byId = { ...state.byId }
  for (const item of list) byId[item.entry.id] = item.entry
  return {
    ...state,
    session,
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
