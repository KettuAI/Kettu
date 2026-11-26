// The host the window shows, as the account menu chose it: the sidebar and every global page
// (Artifacts, Routines, Marketplace, Usage, Search) follow it.

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { focusedPane } from '@renderer/features/split/layout'
import { resolveActiveHostId } from '@renderer/lib/active-host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isMac } from '@renderer/lib/platform'
import type { HostAgentList } from '@renderer/lib/plan-readings'
import { agentsOn, listedAgents, useAgentsStore } from './agents'
import { hostScope, LOCAL_SCOPE, type HostScope } from './host-scope'
import { isAway, otherHosts, shownHosts, useHostsStore, type OtherHost } from './hosts'
import { hostOfSession, useSessionsStore } from './sessions'
import { useViewStore } from './view'

export { resolveActiveHostId }

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
 * The host scope for a Marketplace view: `hostId` when explicitly pinned (null being this
 * computer), otherwise the window's host scope.
 */
export function marketplaceScope(hostId: string | null | undefined): HostScope {
  if (hostId !== undefined) return hostId === null ? LOCAL_SCOPE : hostScope(hostId)
  const shown = windowHost()
  return shown.kind === 'one' && shown.hostId !== null ? hostScope(shown.hostId) : LOCAL_SCOPE
}

export function useMarketplaceScope(hostId: string | null | undefined): HostScope {
  const windowScope = useWindowScope()
  return hostId !== undefined ? (hostId === null ? LOCAL_SCOPE : hostScope(hostId)) : windowScope
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
 * The host when it is another host that is not connected, whose pages show what was last read,
 * greyed and read-only; null for this computer or an online host.
 */
export function useHostAway(hostId: string | null): OtherHost | null {
  return useHostsStore((s) => {
    if (hostId === null) return null
    const host = otherHosts(s).find((h) => h.id === hostId)
    return host && isAway(host.connection) ? host : null
  })
}

/**
 * The host the window is narrowed to while it is not connected, whose pages show what was last
 * read, greyed and read-only; null otherwise.
 */
export function useWindowHostAway(): OtherHost | null {
  const key = useKey()
  return useHostAway(key === ALL ? null : key)
}

/** The active session/project's host now (null for this computer, undefined when none). */
export function activeHostId(): string | null | undefined {
  const view = useViewStore.getState()
  const sessions = useSessionsStore.getState().byId
  return resolveActiveHostId({
    main: view.main,
    focusedPaneView: focusedPane(view.layout).view,
    projectPath: view.projectPath,
    sessionHost: (id) => {
      const summary = sessions[id]
      return summary ? hostOfSession(summary) : undefined
    },
  })
}

/** Reactive active session/project host (null for this computer, undefined when none). */
export function useActiveHostId(): string | null | undefined {
  const main = useViewStore((s) => s.main)
  const focusedPaneView = useViewStore((s) => focusedPane(s.layout).view)
  const projectPath = useViewStore((s) => s.projectPath)
  const sessionId =
    main.kind === 'session'
      ? main.sessionId
      : focusedPaneView.kind === 'session'
        ? focusedPaneView.sessionId
        : null
  const sessionProjectPath = useSessionsStore((s) =>
    sessionId ? s.byId[sessionId]?.projectPath : undefined,
  )
  return useMemo(
    () =>
      resolveActiveHostId({
        main,
        focusedPaneView,
        projectPath,
        sessionHost: (id) =>
          id === sessionId && sessionProjectPath !== undefined
            ? hostOfPath(sessionProjectPath)
            : undefined,
      }),
    [main, focusedPaneView, projectPath, sessionId, sessionProjectPath],
  )
}
