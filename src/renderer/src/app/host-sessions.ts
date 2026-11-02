// The sessions and projects of the other hosts this computer connects to, kept beside this
// computer's in the same stores. They are read whenever a new connection to a host opens, followed
// through its events, and kept in this computer's storage, which lists an offline host's sessions
// also after a restart. A host forgotten here, or one that removed this computer, takes them along.
// Its agents and their cached options are read and followed the same way, but kept in memory only,
// and its terminals' events go to the terminals, which attach again on each new connection.

import type { HostEvent, Project, SessionSummary } from '@shared/agent-host'
import type { HostStatus } from '@shared/remote/hosts'
import type { TerminalEvent } from '@shared/terminal-host'
import {
  forgetHostSessions,
  fromHostEvent,
  fromHostTerminalEvent,
  hostAt,
  learnSessionHosts,
} from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { readJson, writeJson } from '@renderer/lib/storage'
import { forgetHostAgentOptions, readHostAgentOptions } from '@renderer/stores/agent-options'
import { forgetHostAgents, readHostAgents, useAgentsStore } from '@renderer/stores/agents'
import { useHostsStore } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { endTerminals, reattachTerminals, takeTerminalEvent } from '@renderer/stores/terminals'

const CACHE_KEY = 'hosts.sessions'

/** How long changes gather before the kept lists are written again. */
const SAVE_MS = 2000

/** What this computer keeps of each other host's lists, by its id. */
export type HostLists = Record<string, { sessions: SessionSummary[]; projects: Project[] }>

export interface HostSessionHandlers {
  /** One of a host's events, its folders named as the window names them. */
  event(hostId: string, event: HostEvent): void
  /** A new connection to the host opened, after its lists were read again. */
  opened(hostId: string): void
  /** The host dropped patches for this computer: what it shows of the host is read again. */
  resync(hostId: string): void
}

/** Each other host's sessions and projects in the stores, as they are kept. */
export function hostLists(
  byId: Record<string, SessionSummary>,
  projects: readonly Project[],
): HostLists {
  const lists: HostLists = {}
  const of = (hostId: string) => (lists[hostId] ??= { sessions: [], projects: [] })
  for (const summary of Object.values(byId)) {
    const hostId = hostOfPath(summary.projectPath)
    // A run is listed under the routine on its own host, which the window does not show.
    if (hostId !== null && summary.origin !== 'routine' && !summary.prepared) {
      of(hostId).sessions.push(summary)
    }
  }
  for (const project of projects) {
    const hostId = hostOfPath(project.path)
    if (hostId !== null) of(hostId).projects.push(project)
  }
  return lists
}

/** The hosts whose lists go: those no longer known here, and those that removed this computer. */
export function goneHosts(lists: readonly string[], hosts: readonly HostStatus[] | null): string[] {
  if (hosts === null) return []
  const kept = new Set(
    hosts
      .filter((h) => !(h.connection.state === 'stopped' && h.connection.reason === 'removed'))
      .map((h) => h.id),
  )
  return lists.filter((hostId) => !kept.has(hostId))
}

function forget(hostId: string): void {
  useSessionsStore.getState().setAll([], hostId)
  useProjectsStore.getState().setAll([], hostId)
  forgetHostSessions(hostId)
  forgetHostAgents(hostId)
  forgetHostAgentOptions(hostId)
}

async function readLists(hostId: string): Promise<void> {
  try {
    const [sessions, projects] = await Promise.all([
      hostAt(hostId, 'sessions.list', {}),
      hostAt(hostId, 'projects.list', undefined),
    ])
    useSessionsStore.getState().setAll(sessions, hostId)
    useProjectsStore.getState().setAll(projects, hostId)
  } catch (error) {
    console.warn(`Could not read the sessions of host ${hostId}`, error)
  }
}

/** The host's agents and their options, for the menus of its projects. */
function readAgents(hostId: string): void {
  readHostAgents(hostId).catch((error: unknown) =>
    console.warn(`Could not read the agents of host ${hostId}`, error),
  )
  readHostAgentOptions(hostId).catch((error: unknown) =>
    console.warn(`Could not read the agent options of host ${hostId}`, error),
  )
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let saved = ''

function save(): void {
  saveTimer = null
  const lists = hostLists(useSessionsStore.getState().byId, useProjectsStore.getState().projects)
  const text = JSON.stringify(lists)
  if (text === saved) return
  saved = text
  writeJson(CACHE_KEY, lists)
}

function scheduleSave(): void {
  saveTimer ??= setTimeout(save, SAVE_MS)
}

/** Lists what was kept, follows each host's connection, and keeps the lists as they change. */
export function initHostSessions(handlers: HostSessionHandlers): void {
  const kept = readJson<HostLists>(CACHE_KEY, {})
  for (const [hostId, lists] of Object.entries(kept)) {
    if (!Array.isArray(lists?.sessions) || !Array.isArray(lists.projects)) continue
    learnSessionHosts(
      hostId,
      lists.sessions.map((summary) => summary.id),
    )
    useSessionsStore.getState().setAll(lists.sessions, hostId)
    useProjectsStore.getState().setAll(lists.projects, hostId)
  }
  saved = JSON.stringify(kept)

  window.kettu.hosts.onSession((hostId, change) => {
    switch (change.kind) {
      case 'open':
        readAgents(hostId)
        void readLists(hostId).then(() => handlers.opened(hostId))
        void reattachTerminals(hostId)
        break
      case 'resync':
        handlers.resync(hostId)
        break
      case 'event':
        if (change.event.type.startsWith('terminal.')) {
          takeTerminalEvent(fromHostTerminalEvent(hostId, change.event as TerminalEvent))
        } else {
          handlers.event(hostId, fromHostEvent(hostId, change.event as HostEvent))
        }
        break
      case 'terminals-restarted':
        endTerminals(change.ids)
        break
    }
  })

  useHostsStore.subscribe((state, previous) => {
    const hosts = state.status?.hosts ?? null
    if (hosts === (previous.status?.hosts ?? null)) return
    const listed = new Set([
      ...Object.keys(
        hostLists(useSessionsStore.getState().byId, useProjectsStore.getState().projects),
      ),
      ...Object.keys(useAgentsStore.getState().hosts),
    ])
    for (const hostId of goneHosts([...listed], hosts)) forget(hostId)
  })
  useSessionsStore.subscribe((state, previous) => {
    if (state.byId !== previous.byId) scheduleSave()
  })
  useProjectsStore.subscribe((state, previous) => {
    if (state.projects !== previous.projects) scheduleSave()
  })
}
