import { create } from 'zustand'
import type { AgentId } from '@shared/agents'
import type { PortConnectionState } from '@shared/port-rpc'
import type { TerminalCommand, TerminalEvent, TerminalInfo } from '@shared/terminal-host'
import { emitAppEvent } from '@renderer/app/events'
import { errorMessage, terminalHost, terminals, terminalsAt } from '@renderer/lib/host'
import { newSessionPanel, panelSession, toggleTerminal } from '@renderer/stores/view'

// The terminals the renderer knows, this computer's and other hosts' alike, each in the side panel
// of its session or of its project's New session. Output goes straight to the xterm.js instances
// through `sinks`, never through this store, so a flood of output re-renders nothing.

/** The agent that started a terminal, and the session it started it from. */
export interface TerminalOwner {
  agentId: AgentId
  sessionId: string | null
}

export interface TerminalState extends TerminalInfo {
  activity: boolean // printed while its tab was not shown
  stale: boolean // the terminal host restarted without it; its output stays, with Restart
  name: string | null // the user's name for the tab; null follows the process title
  owner: TerminalOwner | null // the agent using it, until the user types into it
  localUrl: string | null // the last local address with a port it printed
}

export type TerminalSide = 'left' | 'right'

interface TerminalsStore {
  byId: Record<string, TerminalState>
  active: Record<string, string> // panel → shown terminal, the left one while split
  order: Record<string, string[]> // panel → tab order the user dragged into
  split: Record<string, string | null> // panel → terminal shown on the right
  focusedSide: Record<string, TerminalSide> // panel → side a selected tab shows in
  connection: PortConnectionState
  error: string | null
}

export const useTerminalsStore = create<TerminalsStore>()(() => ({
  byId: {},
  active: {},
  order: {},
  split: {},
  focusedSide: {},
  connection: 'connected',
  error: null,
}))

type Sink = (data: string) => void
const sinks = new Map<string, Sink>()
/** Starts a drawn terminal's screen over from a replay of its recent output. */
const replays = new Map<string, Sink>()

/** Terminals started to sign in an agent; when their command returns, the session retries. */
const signIns = new Map<string, { agentId: string; sawBusy: boolean }>()

/** The end of each terminal's last output, so an address split across two chunks is found. */
const urlTails = new Map<string, string>()
const URL_TAIL = 200

export function setSink(id: string, sink: Sink | null, replay: Sink | null = null): void {
  if (sink) sinks.set(id, sink)
  else sinks.delete(id)
  if (replay) replays.set(id, replay)
  else replays.delete(id)
}

/** The terminals in tab order: those the order names first, then the rest by creation. */
export function orderTerminals<T extends { id: string; createdAt: number }>(
  list: readonly T[],
  order: readonly string[] = [],
): T[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...list].sort((a, b) => {
    const ra = rank.get(a.id)
    const rb = rank.get(b.id)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.createdAt - b.createdAt
  })
}

/** The side panel a terminal shows in: its session's, or its project's New session's. */
export function terminalPanel(t: Pick<TerminalInfo, 'projectPath' | 'sessionId'>): string {
  return t.sessionId ?? newSessionPanel(t.projectPath)
}

export function terminalsOf(
  byId: Record<string, TerminalState>,
  panel: string,
  order?: readonly string[],
): TerminalState[] {
  return orderTerminals(
    Object.values(byId).filter((t) => terminalPanel(t) === panel),
    order,
  )
}

/** Adds or updates a terminal; `owner` is given only by the call that started it. */
function upsert(info: TerminalInfo, owner?: TerminalOwner | null): void {
  // A host before terminals had sessions sends none: its terminals go to New session.
  info = { ...info, sessionId: info.sessionId ?? null }
  const panel = terminalPanel(info)
  const known = info.id in useTerminalsStore.getState().byId
  useTerminalsStore.setState((s) => {
    const previous = s.byId[info.id]
    return {
      byId: {
        ...s.byId,
        [info.id]: {
          ...info,
          activity: previous?.activity ?? false,
          stale: false,
          name: previous?.name ?? null,
          owner: owner === undefined ? (previous?.owner ?? null) : owner,
          localUrl: previous?.localUrl ?? null,
        },
      },
      active: s.active[panel] ? s.active : { ...s.active, [panel]: info.id },
    }
  })
  if (!known && showOnArrival.delete(panel)) showTerminal(panel, info.id)
  const signIn = signIns.get(info.id)
  if (signIn) {
    if (info.busy) signIn.sawBusy = true
    else if (signIn.sawBusy || info.exitCode !== null) {
      signIns.delete(info.id)
      emitAppEvent({ kind: 'sign-in-finished', agentId: signIn.agentId })
    }
  }
}

/**
 * Panels whose New terminal is waiting on the host. The host announces the terminal before it
 * answers, so it is shown as it arrives rather than a moment after its tab.
 */
const showOnArrival = new Set<string>()

/** A create still waiting on the host. Closing then would hide the tab it is about to show. */
const createsInFlight = new Map<string, number>()

function beginCreate(panel: string): void {
  createsInFlight.set(panel, (createsInFlight.get(panel) ?? 0) + 1)
}

function endCreate(panel: string): void {
  const left = (createsInFlight.get(panel) ?? 1) - 1
  if (left > 0) createsInFlight.set(panel, left)
  else createsInFlight.delete(panel)
}

function createInFlight(panel: string): boolean {
  return (createsInFlight.get(panel) ?? 0) > 0
}

export interface TerminalOpenState {
  panel: string
  open: boolean
}

/**
 * Whether this open of the pane was the user's. `opening` stays set for a second run of the same
 * open, and clears when the panel changes or the pane closes, so a restored or switched session
 * is not taken for one just opened.
 */
export function trackTerminalOpen(
  before: TerminalOpenState,
  now: TerminalOpenState,
  opening: boolean,
): { opening: boolean; explicitOpen: boolean } {
  if (!now.open) return { opening: false, explicitOpen: false }
  const nextOpening = before.panel === now.panel ? opening || !before.open : false
  return { opening: nextOpening, explicitOpen: nextOpening }
}

/**
 * A project's terminal list has come back for a panel in it. An explicit open with no tabs starts
 * one. A pane that was already open closes when the panel has none. A failed or stale list, or a
 * create still in flight, changes nothing.
 */
export function finishTerminalLoad(
  projectPath: string,
  panel: string,
  options: { explicitOpen: boolean; stale: boolean; loaded: boolean },
): void {
  if (!options.loaded || options.stale || createInFlight(panel)) return
  if (terminalsOf(useTerminalsStore.getState().byId, panel).length > 0) return
  if (options.explicitOpen) {
    void createTerminal(projectPath, panel)
    return
  }
  toggleTerminal(panel, false)
}

/** Drops a terminal from the renderer, such as a stale tab the user restarts or closes. */
export function forgetTerminal(id: string): void {
  sinks.delete(id)
  replays.delete(id)
  signIns.delete(id)
  urlTails.delete(id)
  const known = useTerminalsStore.getState().byId[id]
  const removedFrom = known ? terminalPanel(known) : null
  useTerminalsStore.setState((s) => {
    const gone = s.byId[id]
    if (!gone) return s
    const panel = terminalPanel(gone)
    const byId = { ...s.byId }
    delete byId[id]
    const order = { ...s.order }
    const kept = order[panel]?.filter((other) => other !== id)
    if (kept?.length) order[panel] = kept
    else delete order[panel]
    const active = { ...s.active }
    const right = s.split[panel] ?? null
    // Either side going ends the split; the one that stays shows alone.
    if (right === id || (right && active[panel] === id)) {
      if (right !== id) active[panel] = right
      return { byId, active, order, ...unsplit(s, panel) }
    }
    if (active[panel] === id) {
      const next = terminalsOf(byId, panel, order[panel]).at(-1)
      if (next) active[panel] = next.id
      else delete active[panel]
    }
    return { byId, active, order }
  })
  if (!removedFrom || createInFlight(removedFrom)) return
  if (terminalsOf(useTerminalsStore.getState().byId, removedFrom).length === 0) {
    toggleTerminal(removedFrom, false)
  }
}

function unsplit(s: TerminalsStore, panel: string): Pick<TerminalsStore, 'split' | 'focusedSide'> {
  const split = { ...s.split }
  const focusedSide = { ...s.focusedSide }
  delete split[panel]
  delete focusedSide[panel]
  return { split, focusedSide }
}

// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
const LOCAL_URL =
  // eslint-disable-next-line no-control-regex
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{1,5}(?!\d)(?:[/?#][^\s"'<>`\x00-\x1f\x7f]*)?/gi
const TRAILING_PUNCTUATION = /[.,;:!?'")\]}]+$/

/**
 * The last address on this computer with a port in a terminal's output, such as a dev server's
 * `http://localhost:5173/`. An address on 0.0.0.0, every interface, opens as localhost.
 */
export function findLocalUrl(text: string): string | null {
  let found: string | null = null
  for (const match of text.replace(ESCAPES, '').matchAll(LOCAL_URL)) found = match[0]
  if (!found) return null
  return found.replace(TRAILING_PUNCTUATION, '').replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost')
}

/** Notes the local address a terminal prints; most output has no `://` and costs a few scans. */
function scanForLocalUrl(id: string, data: string): void {
  const tail = urlTails.get(id) ?? ''
  urlTails.set(id, data.length >= URL_TAIL ? data.slice(-URL_TAIL) : (tail + data).slice(-URL_TAIL))
  const seam = tail.slice(-2) + data.slice(0, 2)
  if (!data.includes('://') && !tail.includes('://') && !seam.includes('://')) return
  const url = findLocalUrl(tail + data)
  if (!url) return
  useTerminalsStore.setState((s) => {
    const t = s.byId[id]
    if (!t || t.localUrl === url) return s
    return { byId: { ...s.byId, [id]: { ...t, localUrl: url } } }
  })
}

/** A terminal event, from this computer's terminal host or, its folders named, another host's. */
export function takeTerminalEvent(event: TerminalEvent): void {
  switch (event.type) {
    case 'terminal.data': {
      scanForLocalUrl(event.id, event.data)
      const sink = sinks.get(event.id)
      if (sink) {
        sink(event.data)
        return
      }
      // Nobody draws it: acknowledge at once so the process keeps running, and mark the tab.
      void terminals('terminals.ack', { id: event.id, chars: event.data.length }).catch(
        () => undefined,
      )
      const t = useTerminalsStore.getState().byId[event.id]
      if (t && !t.activity) {
        useTerminalsStore.setState((s) => ({
          byId: { ...s.byId, [event.id]: { ...t, activity: true } },
        }))
      }
      return
    }
    case 'terminal.info':
      upsert(event.info)
      return
    // Another host's, after this computer fell behind on it and missed output.
    case 'terminal.replay':
      urlTails.delete(event.id)
      scanForLocalUrl(event.id, event.replay)
      replays.get(event.id)?.(event.replay)
      return
    case 'terminal.removed':
      forgetTerminal(event.id)
  }
}

export function initTerminals(): void {
  const api = window.kettu.terminals
  api.onEvent(takeTerminalEvent)
  api.onConnection((connection) => {
    const was = useTerminalsStore.getState().connection
    useTerminalsStore.setState({ connection })
    // This computer's terminal host gave up; other hosts' terminals go on.
    if (connection === 'failed') markStale((id) => terminalHost(id) === null)
    if (connection === 'connected' && was !== 'connected' && was !== 'resuming') {
      void reconcileTerminals()
    }
  })
}

/** Lists a project's terminals, for example after a reload of the window. False when the list fails. */
export async function loadTerminals(projectPath: string): Promise<boolean> {
  try {
    const list = await terminals('terminals.list', { projectPath })
    for (const info of list) upsert(info)
    return true
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
    return false
  }
}

export interface CreateTerminalOptions extends Partial<TerminalCommand> {
  signInAgent?: string
  /** The agent starting it, which uses it until the user types into it. */
  owner?: TerminalOwner
}

type Size = { cols: number; rows: number }
const SIZE: Size = { cols: 100, rows: 24 }

/**
 * Starts a terminal in a project's folder for a session's panel, or New session's, and shows it,
 * in the focused side while the panel is split.
 */
export async function createTerminal(
  projectPath: string,
  panel: string,
  size: Size = SIZE,
  options?: CreateTerminalOptions,
): Promise<TerminalInfo | null> {
  showOnArrival.add(panel)
  const info = await startTerminal(projectPath, panel, size, options)
  showOnArrival.delete(panel)
  if (info) showTerminal(panel, info.id)
  return info
}

async function startTerminal(
  projectPath: string,
  panel: string,
  size: Size = SIZE,
  options?: CreateTerminalOptions,
): Promise<TerminalInfo | null> {
  beginCreate(panel)
  useTerminalsStore.setState({ error: null })
  const sessionId = panelSession(panel)
  try {
    const info = await terminals('terminals.create', {
      projectPath,
      ...(sessionId ? { sessionId } : {}),
      cols: size.cols,
      rows: size.rows,
      ...(options?.text !== undefined
        ? { command: { text: options.text, run: options.run ?? false } }
        : {}),
    })
    if (options?.signInAgent) signIns.set(info.id, { agentId: options.signInAgent, sawBusy: false })
    upsert(info, options?.owner ?? null)
    return info
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
    return null
  } finally {
    endCreate(panel)
  }
}

/** Gives the terminals New session started in a project to the session it created. */
export async function assignTerminals(projectPath: string, sessionId: string): Promise<void> {
  const from = newSessionPanel(projectPath)
  useTerminalsStore.setState((s) => {
    const moving = terminalsOf(s.byId, from)
    if (moving.length === 0) return s
    const byId = { ...s.byId }
    for (const t of moving) byId[t.id] = { ...t, sessionId }
    const move = <T>(record: Record<string, T>): Record<string, T> => {
      const { [from]: moved, ...rest } = record
      return moved === undefined ? rest : { ...rest, [sessionId]: moved }
    }
    return {
      byId,
      active: move(s.active),
      order: move(s.order),
      split: move(s.split),
      focusedSide: move(s.focusedSide),
    }
  })
  try {
    await terminals('terminals.assign', { projectPath, sessionId })
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
  }
}

/** The terminals of these sessions with a command running, as their store last heard. */
export function busyTerminalsOf(sessionIds: readonly string[]): TerminalState[] {
  const sessions = new Set(sessionIds)
  return Object.values(useTerminalsStore.getState().byId).filter(
    (t) =>
      t.sessionId !== null &&
      sessions.has(t.sessionId) &&
      t.busy &&
      t.exitCode === null &&
      !t.stale,
  )
}

/**
 * Shows a terminal. While split, a tab already on one side focuses that side, and any other
 * takes the place of the focused side's.
 */
export function showTerminal(panel: string, id: string): void {
  useTerminalsStore.setState((s) => {
    const t = s.byId[id]
    const byId = t?.activity ? { ...s.byId, [id]: { ...t, activity: false } } : s.byId
    const right = s.split[panel]
    if (!right) return { active: { ...s.active, [panel]: id }, byId }
    const side: TerminalSide =
      id === right ? 'right' : id === s.active[panel] ? 'left' : (s.focusedSide[panel] ?? 'left')
    return {
      byId,
      focusedSide: { ...s.focusedSide, [panel]: side },
      ...(side === 'right'
        ? { split: { ...s.split, [panel]: id } }
        : { active: { ...s.active, [panel]: id } }),
    }
  })
}

/**
 * The Split button: unsplit, it starts a terminal and shows it on the right, focused; split, it
 * leaves the left one shown and the right one a tab.
 */
export async function toggleSplit(projectPath: string, panel: string): Promise<void> {
  if (useTerminalsStore.getState().split[panel]) {
    useTerminalsStore.setState((s) => unsplit(s, panel))
    return
  }
  const info = await startTerminal(projectPath, panel)
  if (!info) return
  useTerminalsStore.setState((s) => {
    const left = s.active[panel]
    if (!s.byId[info.id] || s.split[panel]) return s
    // Nothing was shown to split from: the new terminal shows alone.
    if (!left || left === info.id || !s.byId[left]) {
      return { active: { ...s.active, [panel]: info.id } }
    }
    return {
      split: { ...s.split, [panel]: info.id },
      focusedSide: { ...s.focusedSide, [panel]: 'right' },
    }
  })
}

/** Where a selected tab shows while split: a click into a side's terminal focuses that side. */
export function focusTerminalSide(panel: string, side: TerminalSide): void {
  useTerminalsStore.setState((s) => {
    if (!s.split[panel] || (s.focusedSide[panel] ?? 'left') === side) return s
    return { focusedSide: { ...s.focusedSide, [panel]: side } }
  })
}

/** The user typed into a terminal an agent was using: it is theirs from now on. */
export function takeOverTerminal(id: string): void {
  if (!useTerminalsStore.getState().byId[id]?.owner) return
  useTerminalsStore.setState((s) => {
    const t = s.byId[id]
    if (!t?.owner) return s
    return { byId: { ...s.byId, [id]: { ...t, owner: null } } }
  })
}

/** Ctrl+C to the terminal's foreground process, as the user would type it. */
export async function interruptTerminal(id: string): Promise<void> {
  try {
    await terminals('terminals.input', { id, data: '\x03' })
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
  }
}

/** Names a tab; a blank name returns it to the title of its process. */
export function renameTerminal(id: string, name: string): void {
  const next = name.trim() || null
  useTerminalsStore.setState((s) => {
    const t = s.byId[id]
    if (!t || t.name === next) return s
    return { byId: { ...s.byId, [id]: { ...t, name: next } } }
  })
}

/** Moves a tab to a place in its panel's row, which the order keeps from then on. */
export function moveTerminal(panel: string, id: string, toIndex: number): void {
  useTerminalsStore.setState((s) => {
    const ids = terminalsOf(s.byId, panel, s.order[panel]).map((t) => t.id)
    const from = ids.indexOf(id)
    const to = Math.min(Math.max(toIndex, 0), ids.length - 1)
    if (from === -1 || from === to) return s
    ids.splice(to, 0, ...ids.splice(from, 1))
    return { order: { ...s.order, [panel]: ids } }
  })
}

export async function killTerminal(id: string): Promise<void> {
  try {
    await terminals('terminals.kill', { id })
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
  }
}

export async function restartTerminal(id: string): Promise<void> {
  useTerminalsStore.setState({ error: null })
  try {
    const info = await terminals('terminals.restart', { id })
    // A new shell the user started: no agent's, with none of the old one's output.
    urlTails.delete(id)
    useTerminalsStore.setState((s) => {
      const t = s.byId[id]
      return t ? { byId: { ...s.byId, [id]: { ...t, owner: null, localUrl: null } } } : s
    })
    upsert(info)
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
  }
}

function markStale(test: (id: string) => boolean): void {
  useTerminalsStore.setState((s) => {
    let byId = s.byId
    for (const [id, t] of Object.entries(s.byId)) {
      if (!t.stale && test(id)) byId = { ...byId, [id]: { ...t, stale: true, busy: false } }
    }
    return byId === s.byId ? s : { byId }
  })
}

/** Another host's terminal host stopped or restarted: these terminals ended with it. */
export function endTerminals(ids: readonly string[]): void {
  const ended = new Set(ids)
  markStale((id) => ended.has(id))
}

/**
 * A new connection to another host opened, or the host allows the terminal again: its terminals
 * still running there attach again, those drawn here starting their screens over from the replay,
 * and the ones it no longer has end.
 */
export async function reattachTerminals(hostId: string): Promise<void> {
  const known = Object.values(useTerminalsStore.getState().byId).filter(
    (t) => !t.stale && terminalHost(t.id) === hostId,
  )
  if (known.length === 0) return
  try {
    const list = await terminalsAt(hostId, 'terminals.list', {})
    const alive = new Set(list.map((t) => t.id))
    markStale((id) => terminalHost(id) === hostId && !alive.has(id))
    for (const info of list) upsert(info)
    await Promise.all(
      known.map(async ({ id }) => {
        const replay = replays.get(id)
        if (!alive.has(id) || !replay) return
        replay((await terminals('terminals.attach', { id })).replay)
      }),
    )
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
  }
}

/** After the terminal host restarted, marks the terminals it no longer has as stale. */
async function reconcileTerminals(): Promise<void> {
  if (Object.keys(useTerminalsStore.getState().byId).length === 0) return
  try {
    const list = await terminals('terminals.list', {})
    const alive = new Set(list.map((t) => t.id))
    markStale((id) => terminalHost(id) === null && !alive.has(id))
    for (const info of list) upsert(info)
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
  }
}

/** A stale tab's Restart: a new shell in the same folder and panel, in the old tab's place. */
export async function replaceStale(id: string): Promise<void> {
  const { byId, connection } = useTerminalsStore.getState()
  const old = byId[id]
  if (!old) return
  // This computer's host that crashed too often stays down until asked to start again.
  if (connection === 'failed' && terminalHost(id) === null) {
    try {
      await window.kettu.terminals.restart()
    } catch (error) {
      useTerminalsStore.setState({ error: errorMessage(error) })
      return
    }
  }
  const created = await startTerminal(old.projectPath, terminalPanel(old))
  if (!created) return
  inheritTab(id, created.id)
  forgetTerminal(id)
}

/**
 * Gives a replacement terminal the name and the place of the one it replaces: its tab, and the
 * right side when it was shown there, or else the shown terminal.
 */
function inheritTab(oldId: string, newId: string): void {
  useTerminalsStore.setState((s) => {
    const old = s.byId[oldId]
    const created = s.byId[newId]
    if (!old || !created) return s
    const panel = terminalPanel(old)
    const ids = terminalsOf(s.byId, panel, s.order[panel])
      .map((t) => t.id)
      .filter((other) => other !== newId)
      .map((other) => (other === oldId ? newId : other))
    const right = s.split[panel] === oldId
    return {
      byId: { ...s.byId, [newId]: { ...created, name: old.name } },
      order: { ...s.order, [panel]: ids },
      ...(right
        ? { split: { ...s.split, [panel]: newId } }
        : { active: { ...s.active, [panel]: newId } }),
    }
  })
}
