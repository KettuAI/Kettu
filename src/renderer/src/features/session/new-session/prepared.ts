// The window's prepared session: the real session New session's first message will use, opened
// while the screen shows, so its menu shows what the agent reports for it. See prepared sessions in
// the session model.

import type { SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { errorMessage, host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import {
  pickOption,
  settlePick,
  useAgentOptionsStore,
  type FirstRead,
  type PreparedState,
} from '@renderer/stores/agent-options'
import { useAgentsStore } from '@renderer/stores/agents'

export interface PrepareTarget {
  agentId: AgentId
  projectPath: string | null // null: No project
  parentId: string | null
}

// It goes this long after New session leaves the front, and after this long untouched in front.
const LEFT_MS = 60_000
const IDLE_MS = 30 * 60_000
// Opening the agent menu replaces one older than this, since a provider's list can change.
export const STALE_MS = 5 * 60_000

let target: PrepareTarget | null = null
let shown = false
let idle = false
let leftTimer: ReturnType<typeof setTimeout> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
// Removed on purpose, so their removal is not taken for the agent's exit.
const discarded = new Set<string>()
const sets = new Set<Promise<unknown>>()

const keyOf = (t: PrepareTarget): string => JSON.stringify([t.agentId, t.projectPath, t.parentId])

const setPrepared = (next: PreparedState | null): void =>
  useAgentOptionsStore.setState({ prepared: next })

/** The prepared session for what New session shows; one for anything else is discarded. */
export function prepareFor(next: PrepareTarget | null): void {
  target = next
  const current = useAgentOptionsStore.getState().prepared
  if (!next) {
    if (current) discardPrepared()
    return
  }
  if (current && current.key !== keyOf(next)) discardPrepared()
  void prepare(next)
}

/** Opens or reuses the prepared session; with `replace`, a new one in place of the one held. */
export async function prepare(t: PrepareTarget, replace = false): Promise<void> {
  const key = keyOf(t)
  const current = useAgentOptionsStore.getState().prepared
  if (!replace && current?.key === key && (current.opening || current.summary)) return
  setPrepared({
    key,
    agentId: t.agentId,
    summary: current?.key === key ? current.summary : null,
    opening: true,
    error: null,
  })
  const picks = useAgentOptionsStore.getState().picks[t.agentId]
  try {
    const summary = await host('sessions.prepare', {
      agentId: t.agentId,
      projectPath: t.projectPath,
      ...(t.parentId ? { parentId: t.parentId } : {}),
      ...(picks && Object.keys(picks).length > 0 ? { options: picks } : {}),
      ...(replace ? { replace: true } : {}),
    })
    if (useAgentOptionsStore.getState().prepared?.key !== key) {
      // Left for another agent or folder meanwhile.
      discard(summary.id)
      return
    }
    setPrepared({ key, agentId: t.agentId, summary, opening: false, error: null })
    for (const [optionId, value] of Object.entries(picks ?? {}))
      settlePick(t.agentId, optionId, value)
    // Picks made while it opened go to it now.
    const later = useAgentOptionsStore.getState().picks[t.agentId] ?? {}
    for (const [optionId, value] of Object.entries(later)) setOption(t.agentId, optionId, value)
  } catch (error) {
    const now = useAgentOptionsStore.getState().prepared
    if (now?.key !== key) return
    setPrepared({ ...now, opening: false, error: errorMessage(error) })
  }
}

function discard(sessionId: string): void {
  discarded.add(sessionId)
  host('sessions.discard', { sessionId }).catch((error: unknown) =>
    console.warn(`Could not discard the prepared session: ${errorMessage(error)}`),
  )
}

/** Removes the window's prepared session; the next use of New session prepares another. */
export function discardPrepared(): void {
  const current = useAgentOptionsStore.getState().prepared
  setPrepared(null)
  if (current?.summary) discard(current.summary.id)
}

/** The first send adopted it, so it is a session of its own now and nothing removes it. */
export function adoptedPrepared(sessionId: string): void {
  if (useAgentOptionsStore.getState().prepared?.summary?.id === sessionId) setPrepared(null)
}

/**
 * A summary of a prepared session, which the host sends to this window alone: the one it holds,
 * changed, or the one that replaced it after the agent's settings changed.
 */
export function receivePrepared(summary: SessionSummary): void {
  const current = useAgentOptionsStore.getState().prepared
  if (!current || current.agentId !== summary.agentId || summary.status !== 'ready') return
  const held = current.summary
  if (
    held &&
    held.id !== summary.id &&
    (summary.prepared?.openedAt ?? 0) < (held.prepared?.openedAt ?? 0)
  ) {
    return
  }
  // A replacement that answered ends the wait; a change to the one held does not.
  const opening = held?.id === summary.id ? current.opening : false
  setPrepared({ ...current, summary, opening, error: null })
}

/** A prepared session the window did not discard went, as with its agent's exit. */
export function preparedRemoved(sessionId: string): boolean {
  if (discarded.delete(sessionId)) return true
  const current = useAgentOptionsStore.getState().prepared
  if (current?.summary?.id !== sessionId) return false
  setPrepared(null)
  if (shown && target && !idle) void prepare(target)
  return true
}

/** Sets an option on the prepared session, showing it at once; it stays a pick until it opens. */
export function setOption(agentId: AgentId, optionId: string, value: string | boolean): void {
  pickOption(agentId, optionId, value)
  const summary = useAgentOptionsStore.getState().prepared?.summary
  if (!summary || summary.agentId !== agentId) return
  const setting = host('sessions.setConfigOption', { sessionId: summary.id, optionId, value })
    .catch((error: unknown) =>
      console.warn(`Could not set ${optionId} on the prepared session: ${errorMessage(error)}`),
    )
    .finally(() => {
      sets.delete(setting)
      settlePick(agentId, optionId, value)
    })
  sets.add(setting)
}

/** Waits for the options being set, so the first message goes with them. */
export async function settleOptions(): Promise<void> {
  await Promise.allSettled([...sets])
}

/** New session is in front: it keeps the prepared session, and has one again after being idle. */
export function enterNewSession(): void {
  shown = true
  if (leftTimer) clearTimeout(leftTimer)
  leftTimer = null
  noteActivity()
}

/** New session left the front: its prepared session goes a minute later unless it comes back. */
export function leaveNewSession(): void {
  shown = false
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (leftTimer) clearTimeout(leftTimer)
  leftTimer = setTimeout(() => {
    leftTimer = null
    if (!shown) discardPrepared()
  }, LEFT_MS)
}

/** Typing, focus or a menu: an idle screen's prepared session comes back, and the idle wait restarts. */
export function noteActivity(): void {
  if (!shown) return
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    idle = true
    discardPrepared()
  }, IDLE_MS)
  if (idle) {
    idle = false
    if (target) void prepare(target)
  }
}

/** Opening the agent menu: a stale prepared session is replaced, and the other agents read again. */
export function refreshOnMenu(runningAgents: readonly AgentId[]): void {
  noteActivity()
  const current = useAgentOptionsStore.getState().prepared
  const openedAt = current?.summary?.prepared?.openedAt
  if (target && current && !current.opening && openedAt && Date.now() - openedAt > STALE_MS) {
    void prepare(target, true)
  }
  for (const agentId of runningAgents) {
    if (agentId === target?.agentId) continue
    host('agents.readOptions', { agentId, projectPath: target?.projectPath ?? null }).catch(
      (error: unknown) =>
        console.warn(`Could not read ${agentId}'s options: ${errorMessage(error)}`),
    )
  }
}

/** The host came back: what it held went with it, so New session in front prepares again. */
export function hostRestarted(hostId: string | null = null): void {
  // Only the host New session's folder is on lost the prepared session.
  const on = target?.projectPath ? hostOfPath(target.projectPath) : null
  if (on !== hostId) return
  setPrepared(null)
  discarded.clear()
  if (shown && target && !idle) void prepare(target)
}

/** Tries the failed prepare again. */
export function retryPrepare(): void {
  if (target) void prepare(target, true)
}

const setFirstRead = (agentId: AgentId, read: FirstRead | null): void =>
  useAgentOptionsStore.setState((s) => {
    const firstReads = { ...s.firstReads }
    if (read) firstReads[agentId] = read
    else delete firstReads[agentId]
    return { firstReads }
  })

/**
 * Reads the options of an agent with none cached while New session has no folder, so its menu
 * lists the models before a project is chosen: once per agent, and after a failure only on a
 * retry. The options reach the cache as any the host sees do.
 */
export async function readFirstOptions(agentId: AgentId, retry = false): Promise<void> {
  const { loaded, byId, firstReads } = useAgentOptionsStore.getState()
  const current = firstReads[agentId]
  if (!loaded || byId[agentId] || current?.reading || (current && !retry)) return
  setFirstRead(agentId, { reading: true, error: null })
  try {
    await host('agents.readFirstOptions', { agentId })
    // An agent that turned out to need signing in read nothing, so it reads once signed in.
    const signIn = useAgentsStore.getState().byId[agentId]?.signIn === 'required'
    setFirstRead(agentId, signIn ? null : { reading: false, error: null })
  } catch (error) {
    setFirstRead(agentId, { reading: false, error: errorMessage(error) })
  }
}
