import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { Platform } from '@shared/platform'
import type { HostConnection, HostsStatus, HostStatus, SshRoute } from '@shared/remote/hosts'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isWeb } from '@renderer/lib/platform'
import { readJson, writeJson } from '@renderer/lib/storage'
import { reattachTerminals } from './terminals'
import { THIS_COMPUTER, useViewStore } from './view'

/** What the window shows of another host this computer connects to. */
export interface OtherHost {
  id: string
  name: string
  platform: Platform
  connection: HostConnection
  /** When a connection last opened or ended; while one is open, when it opened. */
  lastOnlineAt: number | null
  /** Added over SSH, and reached through it. */
  ssh?: SshRoute
}

interface HostsStore {
  /** Other hosts this computer connects to, and this computer; null until the first read. */
  status: HostsStatus | null
  /** The other hosts as an earlier run left them, until the remote host reports its own. */
  kept: OtherHost[]
}

const KEPT_KEY = 'hosts.known'

function readKept(): OtherHost[] {
  if (isWeb) return []
  const kept = readJson<unknown>(KEPT_KEY, [])
  if (!Array.isArray(kept)) return []
  return kept.flatMap((value: Partial<OtherHost> | null) =>
    typeof value?.id === 'string' && typeof value.name === 'string'
      ? [
          {
            id: value.id,
            name: value.name,
            platform: (value.platform ?? 'linux') as Platform,
            // Each is tried again at launch.
            connection: { state: 'connecting' as const },
            lastOnlineAt: typeof value.lastOnlineAt === 'number' ? value.lastOnlineAt : null,
          },
        ]
      : [],
  )
}

export const useHostsStore = create<HostsStore>()(() => ({ status: null, kept: readKept() }))

/** The other hosts, sorted by name: as reported, or as kept until they are. */
export function otherHosts(state: HostsStore): OtherHost[] {
  const hosts: OtherHost[] = state.status?.hosts ?? state.kept
  return [...hosts].sort((a, b) => a.name.localeCompare(b.name))
}

export function useOtherHosts(): OtherHost[] {
  return useHostsStore(useShallow(otherHosts))
}

/** Another host by its id, or null once this computer no longer knows it. */
export function useOtherHost(hostId: string | null): OtherHost | null {
  return useHostsStore((s) =>
    hostId === null ? null : (otherHosts(s).find((h) => h.id === hostId) ?? null),
  )
}

/** The hosts the sidebar lists, this computer (null) first; the one it is narrowed to alone. */
export function shownHosts(hosts: readonly OtherHost[], filter: string | null): (string | null)[] {
  const all = [null, ...hosts.map((h) => h.id)]
  if (filter === null) return all
  const one = filter === THIS_COMPUTER ? null : filter
  return all.includes(one) ? [one] : all
}

/** The hosts the sidebar lists as it lays them out, or null with no other host to group by. */
export function sidebarHosts(): (string | null)[] | null {
  const hosts = otherHosts(useHostsStore.getState())
  return hosts.length > 0 ? shownHosts(hosts, useViewStore.getState().hostFilter) : null
}

/** The other hosts whose sessions show greyed now. */
export function awayHosts(): string[] {
  return otherHosts(useHostsStore.getState())
    .filter((host) => isAway(host.connection))
    .map((host) => host.id)
}

/** Whether a host's sessions show greyed: it is neither connected nor connecting. */
export function isAway(connection: HostConnection | null): boolean {
  return connection !== null && connection.state !== 'online' && connection.state !== 'connecting'
}

/**
 * The hosts whose owner allowed devices the terminal when this computer was last connected to
 * them; kept while a host connects again, so a pane open on it does not close for a dropped
 * connection.
 */
const terminalHosts = new Set<string>()
/** The hosts connected now that do not allow it. */
const refusingHosts = new Set<string>()

/**
 * Notes which hosts allow the terminal, as a status reports them; returns those that allow it again
 * on the same connection, whose terminals were closed meanwhile.
 */
export function noteTerminalHosts(hosts: readonly HostStatus[] | null): string[] {
  const listed = new Set<string>()
  const again: string[] = []
  for (const { id, connection } of hosts ?? []) {
    listed.add(id)
    const online = connection.state === 'online'
    if (online && !connection.terminal) refusingHosts.add(id)
    else if (refusingHosts.delete(id) && online) again.push(id)
    if (connection.state === 'connecting') continue
    if (online && connection.terminal) terminalHosts.add(id)
    else terminalHosts.delete(id)
  }
  for (const id of terminalHosts) if (!listed.has(id)) terminalHosts.delete(id)
  for (const id of refusingHosts) if (!listed.has(id)) refusingHosts.delete(id)
  return again
}

/** Whether a host's terminal opens: this computer's (null) always, another's while it allows it. */
export function allowsTerminal(hostId: string | null): boolean {
  return hostId === null || terminalHosts.has(hostId)
}

/** Whether a project's terminal opens, as `allowsTerminal` says of its host. */
export function useTerminalAllowed(projectPath: string): boolean {
  const hostId = hostOfPath(projectPath)
  // Read again on each change of the status, which the set follows.
  return useHostsStore((s) => (s.status, allowsTerminal(hostId)))
}

function noteStatus(status: HostsStatus): void {
  for (const hostId of noteTerminalHosts(status.hosts)) void reattachTerminals(hostId)
  useHostsStore.setState({ status })
}

/** Follows main's changes; called once at bootstrap. */
export function initHosts(): void {
  window.kettu.hosts.onChanged((status) => {
    noteStatus(status)
    if (!status.hosts) return
    writeJson(
      KEPT_KEY,
      status.hosts.map(({ id, name, platform, lastOnlineAt }) => ({
        id,
        name,
        platform,
        lastOnlineAt,
      })),
    )
  })
}

/** Reads the status, as Settings does when it opens, which also reads the computer's model. */
export async function loadHosts(): Promise<void> {
  // The web client reaches only the host that served it.
  if (isWeb) return
  try {
    noteStatus(await window.kettu.hosts.status())
  } catch (error) {
    console.error('Could not read the hosts', error)
  }
}
