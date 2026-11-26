// The workflow cards of the sessions on screen, as their hosts keep them: read on demand per
// session, refreshed across reconnects, and kept current by the hosts' events, so every window and
// device shows the same answer.

import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import type { WorkflowSuggestion } from '@shared/workflow'
import { errorMessage, hostAt } from '@renderer/lib/host'

export interface SessionSuggestionsState {
  status: 'idle' | 'loading' | 'loaded' | 'error'
  error: string | null
  /** Card ids requested in a completed load that the host did not return. */
  missed: readonly string[]
}

const IDLE_SESSION: SessionSuggestionsState = { status: 'idle', error: null, missed: [] }

export interface EditingSuggestion {
  cardId: string
  /** Incremented on each Edit click so repeated clicks re-trigger composer attention feedback. */
  nonce: number
}

interface SuggestionsStore {
  byId: Record<string, WorkflowSuggestion>
  /** The cards Start was pressed on in this window, which opens their task once it starts. */
  pressed: Record<string, true>
  /** Workflow card currently being edited via the composer, per session id. */
  editing: Record<string, EditingSuggestion>
  /** Load status per `${hostId ?? ''}/${sessionId}` session key. */
  sessions: Record<string, SessionSuggestionsState>
  receive(suggestion: WorkflowSuggestion): void
  startEditing(sessionId: string, cardId: string): void
  stopEditing(sessionId: string, cardId?: string): void
}

function pruneResolvedEditing(
  editing: Record<string, EditingSuggestion>,
  byId: Record<string, WorkflowSuggestion>,
): { editing: Record<string, EditingSuggestion>; changed: boolean } {
  let changed = false
  const next: Record<string, EditingSuggestion> = {}
  for (const [sessionId, entry] of Object.entries(editing)) {
    const card = byId[entry.cardId]
    if (card && card.answer.kind !== 'waiting') {
      changed = true
      continue
    }
    next[sessionId] = entry
  }
  return { editing: changed ? next : editing, changed }
}

/** Returns the active waiting workflow suggestion being edited in `sessionId`, if any. */
export function editingSuggestionFor(
  state: Pick<SuggestionsStore, 'byId' | 'editing'>,
  sessionId: string,
): { card: WorkflowSuggestion; nonce: number } | null {
  const entry = state.editing[sessionId]
  if (!entry) return null
  const card = state.byId[entry.cardId]
  if (!card || card.answer.kind !== 'waiting') return null
  return { card, nonce: entry.nonce }
}

/** Monotonic counter ordering live suggestion events against RPC fetches. */
let generation = 0
/** Last live event generation received per suggestion id. */
const eventGen = new Map<string, number>()
/** Latest fetch generation started per session key. */
const latestLoad = new Map<string, number>()
/** In-flight fetch promises per session key. */
const inFlight = new Map<string, Promise<void>>()
/** Card ids requested while a fetch for the session key is in flight. */
const requestedInFlight = new Map<string, Set<string>>()

export function sessionKey(sessionId: string, hostId: string | null): string {
  return `${hostId ?? ''}/${sessionId}`
}

export const useSuggestionsStore = create<SuggestionsStore>()((set) => ({
  byId: {},
  pressed: {},
  editing: {},
  sessions: {},
  receive(suggestion) {
    eventGen.set(suggestion.id, ++generation)
    set((state) => {
      const nextSessions: Record<string, SessionSuggestionsState> = {}
      let sessionsChanged = false
      for (const [key, entry] of Object.entries(state.sessions)) {
        if (entry.missed.includes(suggestion.id)) {
          nextSessions[key] = {
            ...entry,
            missed: entry.missed.filter((id) => id !== suggestion.id),
          }
          sessionsChanged = true
        } else {
          nextSessions[key] = entry
        }
      }
      const byId = { ...state.byId, [suggestion.id]: suggestion }
      const pruned = pruneResolvedEditing(state.editing, byId)
      return {
        byId,
        ...(pruned.changed ? { editing: pruned.editing } : {}),
        ...(sessionsChanged ? { sessions: nextSessions } : {}),
      }
    })
  },
  startEditing(sessionId, cardId) {
    set((state) => {
      const previous = state.editing[sessionId]
      return {
        editing: {
          ...state.editing,
          [sessionId]: { cardId, nonce: (previous?.nonce ?? 0) + 1 },
        },
      }
    })
  },
  stopEditing(sessionId, cardId) {
    set((state) => {
      const current = state.editing[sessionId]
      if (!current || (cardId !== undefined && current.cardId !== cardId)) return state
      const next = { ...state.editing }
      delete next[sessionId]
      return { editing: next }
    })
  },
}))

export interface LoadSuggestionsOptions {
  /** Start a fresh request even if the session was loaded before or a request is already in flight. */
  force?: boolean
  /** The card id that triggered this load, so missing ids are recorded only after a completed read. */
  requestedId?: string
}

/** Reads a session's workflow suggestion cards from its host and updates the store. */
export function loadSuggestions(
  sessionId: string,
  hostId: string | null,
  options: LoadSuggestionsOptions = {},
): Promise<void> {
  const key = sessionKey(sessionId, hostId)
  const { force = false, requestedId } = options
  if (!force) {
    const active = inFlight.get(key)
    if (active) {
      if (requestedId) requestedInFlight.get(key)?.add(requestedId)
      return active
    }
    const existing = useSuggestionsStore.getState().sessions[key]
    if (existing?.status === 'loaded' && (!requestedId || existing.missed.includes(requestedId))) {
      return Promise.resolve()
    }
  }

  const started = ++generation
  latestLoad.set(key, started)
  const asked = new Set<string>(requestedId ? [requestedId] : [])
  requestedInFlight.set(key, asked)

  useSuggestionsStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [key]: {
        status: 'loading',
        error: null,
        missed: force ? [] : (state.sessions[key]?.missed ?? []),
      },
    },
  }))

  const run = hostAt(hostId, 'workflows.suggestions', { sessionId })
    .then(
      (suggestions) => {
        if (latestLoad.get(key) !== started) return
        useSuggestionsStore.setState((state) => {
          const byId = { ...state.byId }
          for (const suggestion of suggestions) {
            // Keep a live event that arrived after this read started, but refresh older cached state.
            if ((eventGen.get(suggestion.id) ?? 0) < started) {
              byId[suggestion.id] = suggestion
            }
          }
          const current = state.sessions[key]
          const nextMissed = new Set((current?.missed ?? []).filter((id) => byId[id] === undefined))
          for (const id of asked) {
            if (byId[id] === undefined) nextMissed.add(id)
          }
          const pruned = pruneResolvedEditing(state.editing, byId)
          return {
            byId,
            ...(pruned.changed ? { editing: pruned.editing } : {}),
            sessions: {
              ...state.sessions,
              [key]: { status: 'loaded', error: null, missed: [...nextMissed] },
            },
          }
        })
      },
      (caught: unknown) => {
        if (latestLoad.get(key) !== started) return
        useSuggestionsStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            [key]: {
              status: 'error',
              error: errorMessage(caught),
              missed: state.sessions[key]?.missed ?? [],
            },
          },
        }))
      },
    )
    .finally(() => {
      if (latestLoad.get(key) === started) {
        inFlight.delete(key)
        requestedInFlight.delete(key)
      }
    })

  inFlight.set(key, run)
  return run
}

/** A host reconnected: refresh every session whose workflow suggestions were read from it. */
export function suggestionsHostOpened(hostId: string | null): void {
  const prefix = `${hostId ?? ''}/`
  const keys = Object.keys(useSuggestionsStore.getState().sessions).filter((key) =>
    key.startsWith(prefix),
  )
  for (const key of keys) {
    const sessionId = key.slice(prefix.length)
    void loadSuggestions(sessionId, hostId, { force: true })
  }
}

export interface SuggestionLookup {
  card: WorkflowSuggestion | null
  status: 'loading' | 'loaded' | 'error' | 'missing'
  error: string | null
  retry(): void
}

/**
 * The card with this id, read with its session's cards on demand and re-fetched when a new card
 * id appears in a previously loaded session or when retried.
 */
export function useSuggestion(
  id: string | null,
  sessionId: string,
  hostId: string | null,
): SuggestionLookup {
  const key = sessionKey(sessionId, hostId)
  const own = useSuggestionsStore((s) => (id ? (s.byId[id] ?? null) : null))
  const session = useSuggestionsStore((s) => s.sessions[key] ?? IDLE_SESSION)

  const needsLoad =
    id !== null &&
    own === null &&
    (session.status === 'idle' || (session.status === 'loaded' && !session.missed.includes(id)))

  useEffect(() => {
    if (!id || !needsLoad) return
    void loadSuggestions(sessionId, hostId, {
      force: session.status === 'loaded',
      requestedId: id,
    })
  }, [id, needsLoad, session.status, sessionId, hostId])

  const retry = useCallback(() => {
    if (!id) return
    void loadSuggestions(sessionId, hostId, { force: true, requestedId: id })
  }, [id, sessionId, hostId])

  if (!id) return { card: null, status: 'missing', error: null, retry }
  if (own) return { card: own, status: 'loaded', error: null, retry }
  if (session.status === 'error') {
    return { card: null, status: 'error', error: session.error, retry }
  }
  if (session.status === 'loaded' && session.missed.includes(id)) {
    return { card: null, status: 'missing', error: null, retry }
  }
  return { card: null, status: 'loading', error: null, retry }
}

/** Resets module-level caches and store state between unit tests. */
export function resetSuggestionsStore(): void {
  generation = 0
  eventGen.clear()
  latestLoad.clear()
  inFlight.clear()
  requestedInFlight.clear()
  useSuggestionsStore.setState({ byId: {}, pressed: {}, editing: {}, sessions: {} })
}
