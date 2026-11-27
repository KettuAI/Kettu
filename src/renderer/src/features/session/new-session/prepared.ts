// The window's prepared session: the real session New session's first message will use, opened
// while the screen shows, so its menu shows what the agent reports for it. See prepared sessions in
// the session model.

import type { SessionSummary } from '@shared/agent-host'
import type { AgentId, ConfigOption } from '@shared/thread'
import { errorMessage, host, hostAt } from '@renderer/lib/host'
import {
  agentKey,
  optionsLoaded,
  optionsOn,
  pickOption,
  picksOf,
  preparedFor,
  settlePick,
  useAgentOptionsStore,
  type FirstRead,
  type PreparedState,
} from '@renderer/stores/agent-options'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { carryEffortPicks } from './start-options'

export interface PrepareTarget {
  /** The host the session will be on, null for this computer. */
  hostId: string | null
  agentId: AgentId
  projectPath: string | null // null: No project
  parentId: string | null
}

// It goes this long after New session leaves the front, and after this long untouched in front.
const LEFT_MS = 60_000
const IDLE_MS = 30 * 60_000
// Opening the agent menu replaces one older than this, since a provider's list can change.
export const STALE_MS = 5 * 60_000

// Order in which buffered picks are flushed to a prepared session: model first (its choices govern
// effort/reasoning options), then model_config, thought_level, other options, and mode last
// (switching permission mode can restart the agent process and restore the rest).
const FLUSH_ORDER: readonly ConfigOption['category'][] = [
  'model',
  'model_config',
  'thought_level',
  'other',
  'mode',
]

let target: PrepareTarget | null = null
let shown = false
let idle = false
let leftTimer: ReturnType<typeof setTimeout> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
// Removed on purpose, so their removal is not taken for the agent's exit.
const discarded = new Set<string>()
const sets = new Map<Promise<unknown>, { hostId: string | null; agentId: AgentId; gen: number }>()
// Per-prepared-session serialization tail so config option RPCs never race one another.
const optionQueues = new Map<string, Promise<void>>()
// The latest queued value per option, avoiding duplicate flushes when a ready summary races prepare.
const queuedValues = new Map<
  string,
  { sessionId: string; gen: number; seq: number; value: string | boolean }
>()
// The latest set of each option, so an earlier answer that lands late does not stand for it.
const latestSet = new Map<string, number>()
// The options the agent refused, by agent and option, until a later set answers or a send reports it.
const refused = new Map<string, string>()
let nextSet = 0
// Incremented whenever the active prepared session identity changes or clears.
let preparedGen = 0
// Incremented whenever an in-flight prepare is started, replaced, or invalidated.
let prepareToken = 0

const setKey = (hostId: string | null, agentId: AgentId, optionId: string): string =>
  `${agentKey(hostId, agentId)}\0${optionId}`

const keyOf = (t: PrepareTarget): string =>
  JSON.stringify([t.hostId, t.agentId, t.projectPath, t.parentId])

function clearRefused(hostId: string | null, agentId: AgentId): void {
  const prefix = `${agentKey(hostId, agentId)}\0`
  for (const key of refused.keys()) {
    if (key.startsWith(prefix)) refused.delete(key)
  }
}

function setPrepared(next: PreparedState | null): void {
  const prev = useAgentOptionsStore.getState().prepared
  const prevId = prev?.summary?.id ?? null
  const nextId = next?.summary?.id ?? null
  if (prevId !== nextId) {
    preparedGen += 1
    if (prev && prevId !== null) {
      optionQueues.delete(prevId)
      clearRefused(prev.hostId, prev.agentId)
    }
  }
  useAgentOptionsStore.setState({ prepared: next })
}

function optionRank(config: readonly ConfigOption[] | undefined, optionId: string): number {
  const category = config?.find((option) => option.id === optionId)?.category
  if (category) {
    const index = FLUSH_ORDER.indexOf(category)
    return index >= 0 ? index : FLUSH_ORDER.indexOf('other')
  }
  return optionId === 'mode' ? FLUSH_ORDER.indexOf('mode') : FLUSH_ORDER.indexOf('other')
}

function orderOptionIds(
  config: readonly ConfigOption[] | undefined,
  ids: readonly string[],
): string[] {
  return [...ids].sort((a, b) => optionRank(config, a) - optionRank(config, b))
}

function cancelQueuedOption(hostId: string | null, agentId: AgentId, optionId: string): void {
  const key = setKey(hostId, agentId, optionId)
  latestSet.set(key, ++nextSet)
  queuedValues.delete(key)
  refused.delete(key)
}

/** Flushes buffered picks to the active prepared session in dependency order, one at a time. */
function flushPicks(
  hostId: string | null,
  agentId: AgentId,
  config: readonly ConfigOption[] | undefined,
): void {
  const state = useAgentOptionsStore.getState()
  const prepared = preparedFor(state, hostId, agentId)
  const sessionId = prepared?.summary?.id
  if (!sessionId) return
  const pending = picksOf(state, hostId, agentId)
  if (!pending) return
  const entries = Object.entries(pending)
  if (entries.length === 0) return
  const entry = optionsOn(state, hostId)[agentId]
  const sourceConfig = config ?? prepared.summary?.prepared?.config ?? entry?.config
  const modelId = sourceConfig?.find((option) => option.category === 'model')?.id
  const pickedModel = modelId ? pending[modelId] : undefined
  let reconciled = pending
  if (sourceConfig && typeof pickedModel === 'string') {
    reconciled = carryEffortPicks(sourceConfig, entry?.levels ?? {}, pending, pickedModel)
    for (const [id, effort] of entries) {
      const carried = reconciled[id]
      if (carried === effort) continue
      if (carried === undefined) {
        cancelQueuedOption(hostId, agentId, id)
        settlePick(hostId, agentId, id, effort)
      } else {
        pickOption(hostId, agentId, id, carried)
      }
    }
  }
  const gen = preparedGen
  for (const optionId of orderOptionIds(sourceConfig, Object.keys(reconciled))) {
    const value = reconciled[optionId]
    if (value === undefined) continue
    const queued = queuedValues.get(setKey(hostId, agentId, optionId))
    if (queued && queued.sessionId === sessionId && queued.gen === gen && queued.value === value) {
      continue
    }
    sendOption(hostId, agentId, optionId, value)
  }
}

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
  const token = ++prepareToken
  setPrepared({
    key,
    hostId: t.hostId,
    agentId: t.agentId,
    summary: current?.key === key ? current.summary : null,
    opening: true,
    error: null,
  })
  const picks = picksOf(useAgentOptionsStore.getState(), t.hostId, t.agentId)
  try {
    const summary = await host('sessions.prepare', {
      agentId: t.agentId,
      projectPath: t.projectPath,
      ...(t.parentId ? { parentId: t.parentId } : {}),
      ...(picks && Object.keys(picks).length > 0 ? { options: picks } : {}),
      ...(replace ? { replace: true } : {}),
    })
    if (token !== prepareToken || useAgentOptionsStore.getState().prepared?.key !== key) {
      // Left for another agent or folder meanwhile, or superseded by a newer prepare/discard.
      discard(summary.id)
      return
    }
    setPrepared({ key, hostId: t.hostId, agentId: t.agentId, summary, opening: false, error: null })
    for (const [optionId, value] of Object.entries(picks ?? {}))
      settlePick(t.hostId, t.agentId, optionId, value)
    // Picks made while it opened go to it now, serialized in dependency order.
    flushPicks(t.hostId, t.agentId, summary.prepared?.config)
  } catch (error) {
    const now = useAgentOptionsStore.getState().prepared
    if (token !== prepareToken || now?.key !== key) return
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
  prepareToken += 1
  const current = useAgentOptionsStore.getState().prepared
  keepDraftOptions(current)
  setPrepared(null)
  if (current?.summary) discard(current.summary.id)
}

function keepDraftOptions(current: PreparedState | null): void {
  const config = current?.summary?.prepared?.config
  if (!current || !config) return
  const key = agentKey(current.hostId, current.agentId)
  useAgentOptionsStore.setState((s) => ({
    picks: {
      ...s.picks,
      [key]: {
        ...Object.fromEntries(config.map((option) => [option.id, option.value])),
        ...s.picks[key],
      },
    },
  }))
}

/**
 * A session started from New session: if it adopted the prepared session, drop our handle without
 * discarding it; otherwise discard any prepared session held for that agent without copying its
 * one-off options (such as permission mode) into picks for the next session.
 */
export function sessionStarted(hostId: string | null, agentId: AgentId, sessionId: string): void {
  const current = preparedFor(useAgentOptionsStore.getState(), hostId, agentId)
  if (!current) return
  prepareToken += 1
  setPrepared(null)
  if (current.summary && current.summary.id !== sessionId) {
    discard(current.summary.id)
  }
}

/**
 * A summary of a prepared session, which the host sends to this window alone: the one it holds,
 * changed, or the one that replaced it after the agent's settings changed.
 */
export function receivePrepared(summary: SessionSummary, hostId: string | null): void {
  const current = useAgentOptionsStore.getState().prepared
  if (!current || current.hostId !== hostId || current.agentId !== summary.agentId) return
  if (summary.status !== 'ready') return
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
  // The host opened it again after this window's prepare failed, so the picks go to it now.
  if (!held && current.error !== null) {
    flushPicks(hostId, summary.agentId, summary.prepared?.config)
  }
}

/** A prepared session the window did not discard went, as with its agent's exit. */
export function preparedRemoved(sessionId: string): boolean {
  if (discarded.delete(sessionId)) return true
  const current = useAgentOptionsStore.getState().prepared
  if (current?.summary?.id !== sessionId) return false
  prepareToken += 1
  keepDraftOptions(current)
  setPrepared(null)
  if (shown && target && !idle) void prepare(target)
  return true
}

/**
 * Sets an option on the prepared session, showing it at once; it stays a pick until it opens. A
 * model's pick carries the effort picked before to a level the model offers, or drops it, so the
 * first message never waits for a level the model lacks.
 */
export function setOption(
  hostId: string | null,
  agentId: AgentId,
  optionId: string,
  value: string | boolean,
): void {
  const state = useAgentOptionsStore.getState()
  const before = picksOf(state, hostId, agentId) ?? {}
  const entry = optionsOn(state, hostId)[agentId]
  const config = preparedFor(state, hostId, agentId)?.summary?.prepared?.config ?? entry?.config
  const isModel = config?.some((o) => o.id === optionId && o.category === 'model')
  pickOption(hostId, agentId, optionId, value)
  sendOption(hostId, agentId, optionId, value)
  if (!config || !isModel || typeof value !== 'string') return
  const after = carryEffortPicks(config, entry?.levels ?? {}, before, value)
  for (const [id, effort] of Object.entries(before)) {
    const carried = after[id]
    if (carried === effort) continue
    if (carried === undefined) {
      cancelQueuedOption(hostId, agentId, id)
      settlePick(hostId, agentId, id, effort)
    } else {
      pickOption(hostId, agentId, id, carried)
      sendOption(hostId, agentId, id, carried)
    }
  }
}

function sendOption(
  hostId: string | null,
  agentId: AgentId,
  optionId: string,
  value: string | boolean,
): void {
  const { prepared } = useAgentOptionsStore.getState()
  const summary = prepared?.summary
  if (!summary || prepared.hostId !== hostId || summary.agentId !== agentId) return
  const sessionId = summary.id
  const gen = preparedGen
  const key = setKey(hostId, agentId, optionId)
  const seq = ++nextSet
  latestSet.set(key, seq)
  queuedValues.set(key, { sessionId, gen, seq, value })
  const previous = optionQueues.get(sessionId)
  const run = async (): Promise<void> => {
    // Drop stale or superseded updates before issuing another host RPC.
    const current = useAgentOptionsStore.getState().prepared
    if (
      gen !== preparedGen ||
      current?.summary?.id !== sessionId ||
      current.hostId !== hostId ||
      current.summary.agentId !== agentId
    ) {
      return
    }
    if (latestSet.get(key) !== seq) return
    try {
      await host('sessions.setConfigOption', { sessionId, optionId, value })
      if (gen === preparedGen && latestSet.get(key) === seq) refused.delete(key)
    } catch (error: unknown) {
      const message = errorMessage(error)
      console.warn(`Could not set ${optionId} on the prepared session: ${message}`)
      // A later answer or a newer prepared session owns the option now.
      if (gen !== preparedGen || latestSet.get(key) !== seq) return
      if (useAgentOptionsStore.getState().prepared?.summary?.id !== sessionId) return
      const picks = picksOf(useAgentOptionsStore.getState(), hostId, agentId)
      if (picks?.[optionId] !== value) return
      // Take the unapplied value back out, so the row shows the value the agent kept.
      settlePick(hostId, agentId, optionId, value)
      refused.set(key, message)
    }
  }
  const setting = (previous ? previous.then(run) : run()).finally(() => {
    sets.delete(setting)
    if (optionQueues.get(sessionId) === setting) optionQueues.delete(sessionId)
    if (queuedValues.get(key)?.seq === seq) queuedValues.delete(key)
    if (
      gen === preparedGen &&
      latestSet.get(key) === seq &&
      useAgentOptionsStore.getState().prepared?.summary?.id === sessionId
    ) {
      settlePick(hostId, agentId, optionId, value)
    }
  })
  optionQueues.set(sessionId, setting)
  sets.set(setting, { hostId, agentId, gen })
}

/**
 * Waits for the options being set, so the first message goes with them. Rejects with the agent's
 * reasons when it refused a value, so the send does not go on without one the user chose.
 */
export async function settleOptions(hostId: string | null, agentId: AgentId): Promise<void> {
  for (;;) {
    const active = [...sets.entries()]
      .filter(
        ([, meta]) =>
          meta.gen === preparedGen && meta.hostId === hostId && meta.agentId === agentId,
      )
      .map(([promise]) => promise)
    if (active.length === 0) break
    await Promise.allSettled(active)
  }
  const prefix = `${agentKey(hostId, agentId)}\0`
  const reasons = [...refused]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, message]) => message)
  if (reasons.length === 0) return
  for (const key of refused.keys()) if (key.startsWith(prefix)) refused.delete(key)
  throw new Error([...new Set(reasons)].join('\n'))
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

/**
 * Opening the agent menu of the host named: a stale prepared session is replaced, and the other
 * agents of that host read again.
 */
export function refreshOnMenu(hostId: string | null, runningAgents: readonly AgentId[]): void {
  noteActivity()
  const current = useAgentOptionsStore.getState().prepared
  const openedAt = current?.summary?.prepared?.openedAt
  if (target && current && !current.opening && openedAt && Date.now() - openedAt > STALE_MS) {
    void prepare(target, true)
  }
  const folder = target?.hostId === hostId ? (target?.projectPath ?? null) : null
  for (const agentId of runningAgents) {
    if (target?.hostId === hostId && agentId === target.agentId) continue
    hostAt(hostId, 'agents.readOptions', { agentId, projectPath: folder }).catch((error: unknown) =>
      console.warn(`Could not read ${agentId}'s options: ${errorMessage(error)}`),
    )
  }
}

/** The host came back: what it held went with it, so New session in front prepares again. */
export function hostRestarted(hostId: string | null = null): void {
  // Only the host New session's folder is on lost the prepared session.
  if ((target?.hostId ?? null) !== hostId) return
  prepareToken += 1
  keepDraftOptions(useAgentOptionsStore.getState().prepared)
  setPrepared(null)
  discarded.clear()
  if (shown && target && !idle) void prepare(target)
}

/** Tries the failed prepare again. */
export function retryPrepare(): void {
  if (target) void prepare(target, true)
}

/**
 * Replaces the window's prepared session when it targets `projectPath`, keeping any already
 * applied draft options so switching local branches refreshes the agent's workspace context.
 */
export function refreshPreparedForProject(projectPath: string): void {
  const current = useAgentOptionsStore.getState().prepared
  if (!target || target.projectPath !== projectPath || !current) return
  keepDraftOptions(current)
  void prepare(target, true)
}

const setFirstRead = (hostId: string | null, agentId: AgentId, read: FirstRead | null): void =>
  useAgentOptionsStore.setState((s) => {
    const firstReads = { ...s.firstReads }
    const key = agentKey(hostId, agentId)
    if (read) firstReads[key] = read
    else delete firstReads[key]
    return { firstReads }
  })

/**
 * Reads the options of an agent whose own defaults are not cached, while New session has no
 * folder or another agent is picked to take a session over, so its menu lists the models and its
 * modes before it starts: once per agent, and after a failure only on a retry. The options reach
 * the cache as any the host sees do.
 */
export async function readFirstOptions(
  hostId: string | null,
  agentId: AgentId,
  retry = false,
): Promise<void> {
  const state = useAgentOptionsStore.getState()
  const current = state.firstReads[agentKey(hostId, agentId)]
  const cached = optionsOn(state, hostId)[agentId]
  const known = cached && !cached.provisional
  if (!optionsLoaded(state, hostId) || known || current?.reading || (current && !retry)) return
  setFirstRead(hostId, agentId, { reading: true, error: null })
  try {
    await hostAt(hostId, 'agents.readFirstOptions', { agentId })
    // An agent that turned out to need signing in read nothing, so it reads once signed in.
    const signIn = agentsOn(useAgentsStore.getState(), hostId).byId[agentId]?.signIn === 'required'
    setFirstRead(hostId, agentId, signIn ? null : { reading: false, error: null })
  } catch (error) {
    setFirstRead(hostId, agentId, { reading: false, error: errorMessage(error) })
  }
}
