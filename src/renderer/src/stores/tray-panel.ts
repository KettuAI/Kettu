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
  /** The session whose request the panel answers, null while it lists. */
  reviewing: string | null
  /** Counts the panel's openings, so each one starts afresh. */
  shown: number
  /** The request the user was reviewing was answered somewhere else first. */
  answeredElsewhere: boolean
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
  answeredElsewhere: false,
}))

const lastRead = new Map<string, number>()
const reading = new Set<string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

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
    const detail = readDetail(snapshot.entries, snapshot.session.turnStartedAt, summary.updatedAt)
    useTrayPanelStore.setState((state) =>
      state.sessions[sessionId] ? { details: { ...state.details, [sessionId]: detail } } : {},
    )
  } catch (error) {
    console.warn(`Could not read session ${sessionId}`, error)
  } finally {
    reading.delete(sessionId)
  }
  // The session moved on while it was read.
  const now = useTrayPanelStore.getState()
  if (now.sessions[sessionId]?.updatedAt !== now.details[sessionId]?.readAt) schedule(sessionId)
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
  const reviewed = reviewing ? sessions[reviewing] : undefined
  const listed = [...groups.needsYou, ...groups.running, ...groups.finished]
  for (const summary of reviewed ? [reviewed, ...listed] : listed) {
    const moved = details[summary.id]?.readAt !== summary.updatedAt
    if (moved || (running && summary.status === 'running')) schedule(summary.id)
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

function receiveSummary(summary: SessionSummary): void {
  if (summary.prepared) return
  useTrayPanelStore.setState((state) => {
    const sessions = { ...state.sessions, [summary.id]: summary }
    // Another window, a device or a timeout settled the request under review.
    if (state.reviewing === summary.id && !needsYou(summary)) {
      return { sessions, reviewing: null, answeredElsewhere: true }
    }
    return { sessions }
  })
  readListed()
}

function removeSession(sessionId: string): void {
  useTrayPanelStore.setState((state) => {
    const sessions = { ...state.sessions }
    const details = { ...state.details }
    delete sessions[sessionId]
    delete details[sessionId]
    return { sessions, details, reviewing: state.reviewing === sessionId ? null : state.reviewing }
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
      answeredElsewhere: false,
    })),
  )
  document.addEventListener('visibilitychange', followVisibility)
  followVisibility()
  useTrayPanelStore.setState({ remote: await api.remote.status() })
}

export function review(sessionId: string | null): void {
  useTrayPanelStore.setState({ reviewing: sessionId, answeredElsewhere: false })
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
    return { reviewing: null, answeredElsewhere: elsewhere, details }
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
  }
  const others = othersWait(sessionId, request.entryId)
  settled(sessionId, request.entryId, false)
  if (!others) api.tray.hide()
  return null
}
