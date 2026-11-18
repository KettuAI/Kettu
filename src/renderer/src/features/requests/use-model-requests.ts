import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ModelRequest,
  ModelRequestRaw,
  ModelRequestsOverview,
  RequestTurn,
  RequestsSource,
} from '@shared/model-requests'
import type { SessionView } from '@shared/thread'
import { useSessionView } from '@renderer/features/session/use-thread'
import { errorMessage, host } from '@renderer/lib/host'

// The newest page is read again this long after the session's latest request changes, so a
// burst of tool calls costs one read.
const REFRESH_MS = 400

export interface ModelRequestsState {
  /** Null until the first page arrives; false when the agent keeps no record Kettu reads. */
  available: boolean | null
  source: RequestsSource | null
  turns: RequestTurn[]
  overview: ModelRequestsOverview | null
  /** Whether turns before these remain to be read. */
  more: boolean
  loadingOlder: boolean
  error: string | null
}

/**
 * Turns of two pages in order, `older` first: a turn both pages hold, which a page cut in its
 * middle, keeps every request of both, the newer page's copy of one it holds twice.
 */
export function mergeTurns(older: RequestTurn[], newer: RequestTurn[]): RequestTurn[] {
  const byId = new Map(newer.map((turn) => [turn.id, turn]))
  const out: RequestTurn[] = []
  for (const turn of older) {
    const fresh = byId.get(turn.id)
    if (!fresh) {
      out.push(turn)
      continue
    }
    const ids = new Set(fresh.requests.map((r) => r.id))
    const requests: ModelRequest[] = [
      ...turn.requests.filter((r) => !ids.has(r.id)),
      ...fresh.requests,
    ]
    out.push({
      ...fresh,
      index: fresh.index ?? turn.index,
      prompt: fresh.prompt || turn.prompt,
      startedAt: fresh.startedAt ?? turn.startedAt,
      requests,
    })
    byId.delete(turn.id)
  }
  for (const turn of newer) if (byId.has(turn.id)) out.push(turn)
  return out
}

/** What changes with each request the session makes, to read the newest page again on. */
function requestStamp(session: SessionView | undefined): string {
  const last = session?.lastRequest
  return [session?.status, session?.usage?.cache?.lastRequestAt, last?.at, last?.output].join('|')
}

export function useModelRequests(sessionId: string): ModelRequestsState & {
  loadOlder: () => void
  retry: () => void
} {
  const session = useSessionView(sessionId)
  const [state, setState] = useState<ModelRequestsState>({
    available: null,
    source: null,
    turns: [],
    overview: null,
    more: false,
    loadingOlder: false,
    error: null,
  })
  // Where the oldest page read starts, for the page before it.
  const before = useRef<string | null>(null)
  const olderInFlight = useRef(false)
  const [attempt, setAttempt] = useState(0)

  const readNewest = useCallback(async () => {
    try {
      const page = await host('sessions.modelRequests', { sessionId })
      if (!page) {
        setState((s) => ({ ...s, available: false, error: null }))
        return
      }
      setState((s) => {
        // The first read sets where older pages start; later reads only refresh the newest.
        if (s.available === null) before.current = page.before
        return {
          ...s,
          available: true,
          source: page.source,
          turns: s.available === null ? page.turns : mergeTurns(s.turns, page.turns),
          more: s.available === null ? page.before !== null : s.more,
          error: null,
        }
      })
    } catch (error) {
      setState((s) => ({ ...s, error: errorMessage(error) }))
    }
  }, [sessionId])

  const readOverview = useCallback(async () => {
    try {
      const overview = await host('sessions.modelRequestsOverview', { sessionId })
      setState((s) => ({ ...s, overview }))
    } catch {
      // The rows still show; the totals and the system prompt wait for the next read.
    }
  }, [sessionId])

  // The pane is the session's own, so a hook never moves to another session; Retry reads again.
  useEffect(() => {
    void readNewest()
    void readOverview()
  }, [attempt, readNewest, readOverview])

  const stamp = requestStamp(session)
  const status = session?.status

  // An overview that failed to read, as while the host restarts, is read with the next page.
  const missing = state.available === true && state.overview === null
  useEffect(() => {
    if (missing) void readOverview()
  }, [missing, stamp, readOverview])
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const timer = setTimeout(() => void readNewest(), REFRESH_MS)
    return () => clearTimeout(timer)
  }, [stamp, readNewest])

  // The request count, the cost and the tools change by the turn, not by the request.
  const wasRunning = useRef(status === 'running')
  useEffect(() => {
    const running = status === 'running'
    if (wasRunning.current && !running) void readOverview()
    wasRunning.current = running
  }, [status, readOverview])

  const loadOlder = useCallback(() => {
    const from = before.current
    if (from === null || olderInFlight.current) return
    olderInFlight.current = true
    setState((s) => ({ ...s, loadingOlder: true }))
    host('sessions.modelRequests', { sessionId, before: from })
      .then((page) => {
        before.current = page?.before ?? null
        setState((s) => ({
          ...s,
          turns: page ? mergeTurns(page.turns, s.turns) : s.turns,
          more: !!page?.before,
          loadingOlder: false,
        }))
      })
      .catch((error: unknown) =>
        setState((s) => ({ ...s, loadingOlder: false, error: errorMessage(error) })),
      )
      .finally(() => {
        olderInFlight.current = false
      })
  }, [sessionId])

  return { ...state, loadOlder, retry: () => setAttempt((n) => n + 1) }
}

/**
 * A request's records as the agent wrote them, read when it opens; whole once asked. Its user is
 * keyed by `raw`, so it never moves to another request.
 */
export function useRequestRaw(
  sessionId: string,
  raw: string | null,
): {
  value: ModelRequestRaw | null
  error: string | null
  full: () => Promise<ModelRequestRaw>
  showFull: () => void
} {
  const [value, setValue] = useState<ModelRequestRaw | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (raw === null) return
    let live = true
    host('sessions.modelRequestRaw', { sessionId, raw })
      .then((result) => live && setValue(result))
      .catch((e: unknown) => live && setError(errorMessage(e)))
    return () => {
      live = false
    }
  }, [sessionId, raw])
  const full = useCallback(
    () => host('sessions.modelRequestRaw', { sessionId, raw: raw ?? '', full: true }),
    [sessionId, raw],
  )
  const showFull = useCallback(() => {
    full()
      .then(setValue)
      .catch((e: unknown) => setError(errorMessage(e)))
  }, [full])
  return { value, error, full, showFull }
}
