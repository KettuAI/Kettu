import { create } from 'zustand'
import { ALREADY_ANSWERED, type AgentStatus, type SessionSummary } from '@shared/agent-host'
import type { BrowserOriginDecision } from '@shared/browser'
import { isPortError, type PortConnectionState } from '@shared/port-rpc'
import type { RemoteStatus } from '@shared/remote/status'
import type { TrayPanelApi } from '@shared/tray'
import {
  groupSessions,
  needsYou,
  readDetail,
  stale,
  type PendingRequest,
  type SessionDetail,
} from '@renderer/features/tray/model'

/** How soon a session's thread is read again while it changes, so a busy turn reads it seldom. */
const READ_INTERVAL_MS = 1500
/**
 * How often a running session's thread is read while the panel shows: its summary does not move
 * with each step, and the panel watches no thread.
 */
const RUNNING_INTERVAL_MS = 3000

/** The menu bar panel's page has its own preload, which exposes these calls alone. */
export function trayApi(): TrayPanelApi {
  return window.kettu as unknown as TrayPanelApi
}

interface TrayPanelStore {
  connection: PortConnectionState | null
  loaded: boolean
  sessions: Record<string, SessionSummary>
  details: Record<string, SessionDetail>
  agents: AgentStatus[]
  remote: RemoteStatus | null
  /** The request the panel answers, null while it lists. */
  reviewing: Reviewed | null
  /** Counts the panel's openings, so each one starts afresh. */
  shown: number
  /** The session whose request under review was settled somewhere else first. */
  answeredElsewhere: string | null
}

export interface Reviewed {
  sessionId: string
  entryId: string
}

export const useTrayPanelStore = create<TrayPanelStore>()(() => ({
  connection: null,
  loaded: false,
  sessions: {},
  details: {},
  agents: [],
  remote: null,
  reviewing: null,
  shown: 0,
  answeredElsewhere: null,
}))

const lastRead = new Map<string, number>()
const reading = new Set<string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
// The request the panel itself is answering: its session's summary can arrive before the answer's
// result does, and must not read as settled elsewhere.
let answering: string | null = null

function visible(): boolean {
  return document.visibilityState === 'visible'
}

async function readThread(sessionId: string): Promise<void> {
  const summary = useTrayPanelStore.getState().sessions[sessionId]
  if (!summary || reading.has(sessionId)) return
  reading.add(sessionId)
  lastRead.set(sessionId, Date.now())
  try {
    const snapshot = await trayApi().agents.request('sessions.snapshot', { sessionId })
    const detail = readDetail(snapshot.entries, snapshot.session.turnStartedAt, summary)
    useTrayPanelStore.setState((state) => {
      if (!state.sessions[sessionId]) return {}
      const details = { ...state.details, [sessionId]: detail }
      return { details, ...settledElsewhere(state, state.sessions, details) }
    })
  } catch (error) {
    console.warn(`Could not read session ${sessionId}`, error)
  } finally {
    reading.delete(sessionId)
  }
  // The session moved on while it was read.
  const now = useTrayPanelStore.getState()
  const latest = now.sessions[sessionId]
  if (latest && stale(latest, now.details[sessionId])) schedule(sessionId)
}

function schedule(sessionId: string): void {
  if (timers.has(sessionId) || !visible()) return
  const wait = Math.max(0, (lastRead.get(sessionId) ?? 0) + READ_INTERVAL_MS - Date.now())
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId)
      void readThread(sessionId)
    }, wait),
  )
}

/** Reads the threads of the listed sessions that changed, and with `running`, every running one. */
function readListed(running = false): void {
  if (!visible()) return
  const { sessions, details, reviewing } = useTrayPanelStore.getState()
  const groups = groupSessions(Object.values(sessions))
  const reviewed = reviewing ? sessions[reviewing.sessionId] : undefined
  const listed = [...groups.needsYou, ...groups.running, ...groups.finished]
  for (const summary of reviewed ? [reviewed, ...listed] : listed) {
    if (stale(summary, details[summary.id]) || (running && summary.status === 'running')) {
      schedule(summary.id)
    }
  }
}

let runningTimer: ReturnType<typeof setInterval> | null = null

/** While the panel shows, its running rows follow the agents' steps. */
function followVisibility(): void {
  if (runningTimer) clearInterval(runningTimer)
  runningTimer = null
  if (!visible()) return
  readListed(true)
  runningTimer = setInterval(() => readListed(true), RUNNING_INTERVAL_MS)
}

/**
 * Lists again, and says so, once another window, a device or a timeout settled the request under
 * review, so a key meant for it never answers the next one.
 */
function settledElsewhere(
  state: TrayPanelStore,
  sessions: TrayPanelStore['sessions'],
  details: TrayPanelStore['details'],
): Partial<TrayPanelStore> {
  const { reviewing } = state
  if (!reviewing || reviewing.entryId === answering) return {}
  const summary = sessions[reviewing.sessionId]
  const requests = details[reviewing.sessionId]?.requests
  const pending =
    summary !== undefined &&
    needsYou(summary) &&
    (requests?.some((r) => r.entryId === reviewing.entryId) ?? true)
  return pending ? {} : { reviewing: null, answeredElsewhere: reviewing.sessionId }
}

function receiveSummary(summary: SessionSummary): void {
  if (summary.prepared) return
  useTrayPanelStore.setState((state) => {
    const sessions = { ...state.sessions, [summary.id]: summary }
    return { sessions, ...settledElsewhere(state, sessions, state.details) }
  })
  readListed()
}

function removeSession(sessionId: string): void {
  useTrayPanelStore.setState((state) => {
    const sessions = { ...state.sessions }
    const details = { ...state.details }
    delete sessions[sessionId]
    delete details[sessionId]
    const reviewing = state.reviewing?.sessionId === sessionId ? null : state.reviewing
    return { sessions, details, reviewing }
  })
}

async function load(): Promise<void> {
  const api = trayApi()
  const [sessions, agents] = await Promise.all([
    api.agents.request('sessions.list', {}),
    api.agents.request('agents.list', undefined),
  ])
  useTrayPanelStore.setState({
    loaded: true,
    sessions: Object.fromEntries(sessions.filter((s) => !s.prepared).map((s) => [s.id, s])),
    agents,
  })
  readListed()
}

/** Follows the host and remote access, and reads what changed whenever the panel comes forward. */
export async function initTrayPanel(): Promise<void> {
  const api = trayApi()
  api.agents.onEvent((event) => {
    switch (event.type) {
      case 'session.summary':
        receiveSummary(event.summary)
        return
      case 'session.removed':
        removeSession(event.sessionId)
        return
      case 'agent.status':
        useTrayPanelStore.setState((state) => ({
          agents: [...state.agents.filter((a) => a.id !== event.status.id), event.status],
        }))
        return
      case 'agent.removed':
        useTrayPanelStore.setState((state) => ({
          agents: state.agents.filter((a) => a.id !== event.agentId),
        }))
    }
  })
  api.agents.onConnection((connection) => {
    useTrayPanelStore.setState({ connection })
    if (connection === 'connected') {
      load().catch((error: unknown) => console.warn('Could not list the sessions', error))
    }
  })
  api.remote.onChanged((remote) => useTrayPanelStore.setState({ remote }))
  api.tray.onShown(() =>
    useTrayPanelStore.setState((state) => ({
      reviewing: null,
      shown: state.shown + 1,
      answeredElsewhere: null,
    })),
  )
  document.addEventListener('visibilitychange', followVisibility)
  followVisibility()
  useTrayPanelStore.setState({ remote: await api.remote.status() })
}

/** Reviews the first request a session waits on, or lists again with null. */
export function review(sessionId: string | null): void {
  useTrayPanelStore.setState((state) => {
    const request = sessionId ? state.details[sessionId]?.requests[0] : undefined
    const reviewing = sessionId && request ? { sessionId, entryId: request.entryId } : null
    return { reviewing, answeredElsewhere: null }
  })
}

/** Whether any listed session still waits for an answer other than the one just given. */
function othersWait(sessionId: string, entryId: string): boolean {
  const { sessions, details } = useTrayPanelStore.getState()
  return groupSessions(Object.values(sessions)).needsYou.some((summary) => {
    const requests = details[summary.id]?.requests ?? []
    if (summary.id !== sessionId) return true
    return requests.some((request) => request.entryId !== entryId)
  })
}

/** Lists again without the settled request. */
function settled(sessionId: string, entryId: string, elsewhere: boolean): void {
  useTrayPanelStore.setState((state) => {
    const detail = state.details[sessionId]
    const details = detail
      ? {
          ...state.details,
          [sessionId]: {
            ...detail,
            requests: detail.requests.filter((r) => r.entryId !== entryId),
          },
        }
      : state.details
    return { reviewing: null, answeredElsewhere: elsewhere ? sessionId : null, details }
  })
}

export type AnswerChoice = { optionId: string } | { decision: BrowserOriginDecision }

/**
 * Answers a request, then lists again, or closes the panel when nothing else waits; when another
 * window or device answered first, it lists again and says so. Null once settled either way; the
 * message of any other failure.
 */
export async function answer(
  sessionId: string,
  request: PendingRequest,
  choice: AnswerChoice,
): Promise<string | null> {
  const api = trayApi()
  answering = request.entryId
  try {
    if (request.kind === 'tool' && 'optionId' in choice) {
      await api.agents.request('permissions.respond', {
        sessionId,
        requestId: request.permission.requestId,
        optionId: choice.optionId,
      })
    } else if (request.kind === 'origin' && 'decision' in choice) {
      await api.agents.request('browser.answerOrigin', {
        sessionId,
        entryId: request.entryId,
        decision: choice.decision,
      })
    }
  } catch (error) {
    // The preload rejects with the port's plain error object, which keeps its code and data.
    if (!isPortError(error)) return String(error)
    const already =
      error.code === 'not_found' &&
      (error.data as { reason?: unknown } | undefined)?.reason === ALREADY_ANSWERED
    if (!already) return error.message
    settled(sessionId, request.entryId, true)
    return null
  } finally {
    answering = null
  }
  const others = othersWait(sessionId, request.entryId)
  settled(sessionId, request.entryId, false)
  if (!others) api.tray.hide()
  return null
}
