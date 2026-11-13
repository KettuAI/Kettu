// The host the window shows, as the account menu chose it: the sidebar and every global page
// (Artifacts, Routines, Marketplace, Usage, Search) follow it.

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { isMac } from '@renderer/lib/platform'
import type { HostAgentList } from '@renderer/lib/plan-readings'
import { agentsOn, listedAgents, useAgentsStore } from './agents'
import { hostScope, LOCAL_SCOPE, type HostScope } from './host-scope'
import { isAway, otherHosts, shownHosts, useHostsStore, type OtherHost } from './hosts'
import { useViewStore } from './view'

/** One host, null being this computer, or every host side by side. */
export type WindowHost = { kind: 'one'; hostId: string | null } | { kind: 'all' }

const ALL = 'all'

/** As a string, so a selector can return it without a new object each time. */
function keyOf(hosts: readonly OtherHost[], filter: string | null): string | null {
  if (hosts.length === 0) return null
  const shown = shownHosts(hosts, filter)
  return shown.length === 1 ? shown[0]! : ALL
}

function fromKey(key: string | null): WindowHost {
  return key === ALL ? { kind: 'all' } : { kind: 'one', hostId: key }
}

function currentKey(): string | null {
  return keyOf(otherHosts(useHostsStore.getState()), useViewStore.getState().hostFilter)
}

function useKey(): string | null {
  const filter = useViewStore((s) => s.hostFilter)
  return useHostsStore((s) => keyOf(otherHosts(s), filter))
}

/** The window's host now; this computer alone while no other host is added. */
export function windowHost(): WindowHost {
  return fromKey(currentKey())
}

export function useWindowHost(): WindowHost {
  return fromKey(useKey())
}

/** The hosts the window's pages list, this computer (null) first. */
export function windowHosts(): (string | null)[] {
  const host = windowHost()
  if (host.kind === 'one') return [host.hostId]
  return [null, ...otherHosts(useHostsStore.getState()).map((h) => h.id)]
}

/** Whether a page lists what is on `hostId`, null being this computer. */
export function useShowsHost(): (hostId: string | null) => boolean {
  const key = useKey()
  return (hostId) => key === ALL || key === hostId
}

/**
 * The host a page that manages one host at a time works on: the chosen host, or this computer
 * while every host is shown.
 */
export function useWindowScope(): HostScope {
  const key = useKey()
  return key === null || key === ALL ? LOCAL_SCOPE : hostScope(key)
}

/**
 * The agents of the hosts the window shows, this computer (null) first, as menus and pages list
 * them: added ones that are not turned off.
 */
export function shownHostAgents(): HostAgentList[] {
  const state = useAgentsStore.getState()
  return windowHosts().map((hostId) => ({ hostId, agents: listedAgents(agentsOn(state, hostId)) }))
}

export function useShownHostAgents(): HostAgentList[] {
  const key = useKey()
  const others = useHostsStore(useShallow((s) => otherHosts(s).map((h) => h.id)))
  const ids = useMemo(() => (key === ALL ? [null, ...others] : [key]), [key, others])
  const lists = useAgentsStore(useShallow((s) => ids.map((id) => agentsOn(s, id))))
  return useMemo(
    () => ids.map((hostId, index) => ({ hostId, agents: listedAgents(lists[index]!) })),
    [ids, lists],
  )
}

/** Whether pages name hosts at all: only once another host is added. */
export function useNamesHosts(): boolean {
  return useHostsStore((s) => otherHosts(s).length > 0)
}

/** A host's name as the pages write it: "This Mac" or "This computer" for this computer. */
export function useHostName(): (hostId: string | null) => string {
  const { t } = useTranslation('shell')
  const hosts = useHostsStore((s) => s.status?.hosts ?? s.kept)
  return useCallback(
    (hostId) => {
      if (hostId === null) return t(isMac ? 'windowHost.thisMac' : 'windowHost.thisComputer')
      return hosts.find((h) => h.id === hostId)?.name ?? t('windowHost.unknown')
    },
    [hosts, t],
  )
}

/**
 * The host the window is narrowed to while it is not connected, whose pages show what was last
 * read, greyed and read-only; null otherwise.
 */
export function useWindowHostAway(): OtherHost | null {
  const key = useKey()
  return useHostsStore((s) => {
    if (key === null || key === ALL) return null
    const host = otherHosts(s).find((h) => h.id === key)
    return host && isAway(host.connection) ? host : null
  })
}
