import { create } from 'zustand'
import type { PortConnectionState } from '@shared/port-rpc'
import type { TerminalCommand, TerminalEvent, TerminalInfo } from '@shared/terminal-host'
import { emitAppEvent } from '@renderer/app/events'
import { errorMessage, terminals } from '@renderer/lib/host'

// The terminals the renderer knows, per project. Output goes straight to the xterm.js instances
// through `sinks`, never through this store, so a flood of output re-renders nothing.

export interface TerminalState extends TerminalInfo {
  activity: boolean // printed while its tab was not shown
  stale: boolean // the terminal host restarted without it; its output stays, with Restart
  name: string | null // the user's name for the tab; null follows the process title
}

interface TerminalsStore {
  byId: Record<string, TerminalState>
  active: Record<string, string> // projectPath → shown terminal
  order: Record<string, string[]> // projectPath → tab order the user dragged into
  connection: PortConnectionState
  error: string | null
}

export const useTerminalsStore = create<TerminalsStore>()(() => ({
  byId: {},
  active: {},
  order: {},
  connection: 'connected',
  error: null,
}))

type Sink = (data: string) => void
const sinks = new Map<string, Sink>()

/** Terminals started to sign in an agent; when their command returns, the session retries. */
const signIns = new Map<string, { agentId: string; sawBusy: boolean }>()

export function setSink(id: string, sink: Sink | null): void {
  if (sink) sinks.set(id, sink)
  else sinks.delete(id)
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

export function terminalsOf(
  byId: Record<string, TerminalState>,
  projectPath: string,
  order?: readonly string[],
): TerminalState[] {
  return orderTerminals(
    Object.values(byId).filter((t) => t.projectPath === projectPath),
    order,
  )
}

function upsert(info: TerminalInfo): void {
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
        },
      },
      active: s.active[info.projectPath] ? s.active : { ...s.active, [info.projectPath]: info.id },
    }
  })
  const signIn = signIns.get(info.id)
  if (signIn) {
    if (info.busy) signIn.sawBusy = true
    else if (signIn.sawBusy || info.exitCode !== null) {
      signIns.delete(info.id)
      emitAppEvent({ kind: 'sign-in-finished', agentId: signIn.agentId })
    }
  }
}

/** Drops a terminal from the renderer, such as a stale tab the user restarts or closes. */
export function forgetTerminal(id: string): void {
  sinks.delete(id)
  signIns.delete(id)
  useTerminalsStore.setState((s) => {
    const gone = s.byId[id]
    if (!gone) return s
    const byId = { ...s.byId }
    delete byId[id]
    const order = { ...s.order }
    const kept = order[gone.projectPath]?.filter((other) => other !== id)
    if (kept?.length) order[gone.projectPath] = kept
    else delete order[gone.projectPath]
    const active = { ...s.active }
    if (active[gone.projectPath] === id) {
      const next = terminalsOf(byId, gone.projectPath, order[gone.projectPath]).at(-1)
      if (next) active[gone.projectPath] = next.id
      else delete active[gone.projectPath]
    }
    return { byId, active, order }
  })
}

function onEvent(event: TerminalEvent): void {
  switch (event.type) {
    case 'terminal.data': {
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
    case 'terminal.removed':
      forgetTerminal(event.id)
  }
}

export function initTerminals(): void {
  const api = window.kettu.terminals
  api.onEvent(onEvent)
  api.onConnection((connection) => {
    const was = useTerminalsStore.getState().connection
    useTerminalsStore.setState({ connection })
    if (connection === 'failed') markStale(() => true)
    if (connection === 'connected' && was !== 'connected') void reconcileTerminals()
  })
}

/** Lists a project's terminals, for example after a reload of the window. */
export async function loadTerminals(projectPath: string): Promise<void> {
  try {
    const list = await terminals('terminals.list', { projectPath })
    for (const info of list) upsert(info)
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
  }
}

export async function createTerminal(
  projectPath: string,
  size: { cols: number; rows: number } = { cols: 100, rows: 24 },
  command?: TerminalCommand & { signInAgent?: string },
): Promise<TerminalInfo | null> {
  useTerminalsStore.setState({ error: null })
  try {
    const info = await terminals('terminals.create', {
      projectPath,
      cols: size.cols,
      rows: size.rows,
      ...(command ? { command: { text: command.text, run: command.run } } : {}),
    })
    if (command?.signInAgent) signIns.set(info.id, { agentId: command.signInAgent, sawBusy: false })
    upsert(info)
    showTerminal(projectPath, info.id)
    return info
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
    return null
  }
}

export function showTerminal(projectPath: string, id: string): void {
  useTerminalsStore.setState((s) => {
    const t = s.byId[id]
    return {
      active: { ...s.active, [projectPath]: id },
      byId: t?.activity ? { ...s.byId, [id]: { ...t, activity: false } } : s.byId,
    }
  })
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

/** Moves a tab to a place in its project's row, which the order keeps from then on. */
export function moveTerminal(projectPath: string, id: string, toIndex: number): void {
  useTerminalsStore.setState((s) => {
    const ids = terminalsOf(s.byId, projectPath, s.order[projectPath]).map((t) => t.id)
    const from = ids.indexOf(id)
    const to = Math.min(Math.max(toIndex, 0), ids.length - 1)
    if (from === -1 || from === to) return s
    ids.splice(to, 0, ...ids.splice(from, 1))
    return { order: { ...s.order, [projectPath]: ids } }
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
    upsert(await terminals('terminals.restart', { id }))
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

/** After the terminal host restarted, marks the terminals it no longer has as stale. */
async function reconcileTerminals(): Promise<void> {
  if (Object.keys(useTerminalsStore.getState().byId).length === 0) return
  try {
    const list = await terminals('terminals.list', {})
    const alive = new Set(list.map((t) => t.id))
    markStale((id) => !alive.has(id))
    for (const info of list) upsert(info)
  } catch (error) {
    useTerminalsStore.setState({ error: errorMessage(error) })
  }
}

/** A stale tab's Restart: a new shell in the same project, in the old tab's place. */
export async function replaceStale(id: string): Promise<void> {
  const { byId, connection } = useTerminalsStore.getState()
  const old = byId[id]
  if (!old) return
  // A host that crashed too often stays down until asked to start again.
  if (connection === 'failed') {
    try {
      await window.kettu.terminals.restart()
    } catch (error) {
      useTerminalsStore.setState({ error: errorMessage(error) })
      return
    }
  }
  const created = await createTerminal(old.projectPath)
  if (!created) return
  inheritTab(id, created.id)
  forgetTerminal(id)
}

/** Gives a replacement terminal the name and the place of the one it replaces. */
function inheritTab(oldId: string, newId: string): void {
  useTerminalsStore.setState((s) => {
    const old = s.byId[oldId]
    const created = s.byId[newId]
    if (!old || !created) return s
    const ids = terminalsOf(s.byId, old.projectPath, s.order[old.projectPath])
      .map((t) => t.id)
      .filter((other) => other !== newId)
      .map((other) => (other === oldId ? newId : other))
    return {
      byId: { ...s.byId, [newId]: { ...created, name: old.name } },
      order: { ...s.order, [old.projectPath]: ids },
    }
  })
}
