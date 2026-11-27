import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { MarketConnection, MarketServer, McpSpec } from '@shared/marketplace'
import type { McpServerInsight, McpToolChanges } from '@shared/mcp-insight'
import type { AgentId } from '@shared/thread'
import { agentName, menuAgents, usableAgents } from '@renderer/stores/agents'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'
import { busyKey } from '@renderer/stores/marketplace'
import { count } from '@renderer/lib/format'
import { listingIdOf } from '@shared/market-community'
import { errorMessage } from '@renderer/lib/host'
import {
  catalogEntry,
  fromCatalog,
  fromKept,
  matchesQuery,
  oauthFlow,
  updateFor,
  type Listing,
} from './model'

/** An agent's name on the host the page shows. */
export function useAgentName(): (agentId: AgentId) => string {
  const { hostId } = useHostScope()
  return (agentId) => agentName(agentId, hostId)
}

/** The agents a server or skill can be given: those the agent menu lists. */
export function useChoosableAgents() {
  const { useAgentsStore } = useHostScope()
  return useAgentsStore(useShallow((s) => menuAgents(s.order, s.byId)))
}

/** Whether Kettu keeps the server with this id. */
export function useKept(id: string): boolean {
  const { useSettingsStore } = useHostScope()
  return useSettingsStore((s) => s.settings.marketplace.mcp.some((server) => server.id === id))
}

/** Whether Kettu keeps the skill with this id. */
export function useKeptSkill(id: string): boolean {
  const { useSettingsStore } = useHostScope()
  return useSettingsStore((s) => s.settings.marketplace.skills.some((skill) => skill.id === id))
}

export function useInstalling(id: string): boolean {
  return useBusy(busyKey('mcp', id))
}

export function useBusy(key: string): boolean {
  const { useMarketplaceStore } = useHostScope()
  return useMarketplaceStore((s) => s.busy.includes(key))
}

/** "12.3K installs" as the marketplace counts them. */
export function useInstallsLabel(): (installs: number | null) => string | null {
  const { t } = useTranslation('marketplace')
  return (installs) =>
    installs === null ? null : t('plugin.installs', { count: installs, value: count(installs) })
}

/** Where a kept OAuth server stands with its sign-in; null until the host said. */
export function useConnection(serverId: string): MarketConnection | null {
  const { useMarketplaceStore } = useHostScope()
  return useMarketplaceStore((s) => s.connections?.[serverId] ?? null)
}

/** A Connect of the server under way or failed. */
export function useConnectFlow(serverId: string) {
  const { useMarketplaceStore } = useHostScope()
  return useMarketplaceStore((s) => s.connecting[serverId] ?? null)
}

/** A connection in words, for a row's line. */
export function useConnectionText(): (connection: MarketConnection | null) => string | null {
  const { t } = useTranslation('marketplace')
  return (connection) => {
    if (!connection) return null
    if (connection.state === 'connected') {
      return connection.account
        ? t('connection.connectedAs', { account: connection.account })
        : t('connection.connected')
    }
    if (connection.state === 'needs-reconnect') return t('connection.needsReconnect')
    if (connection.state === 'error') return t('connection.error', { message: connection.message })
    return t('connection.disconnected')
  }
}

/**
 * For an item installed from the Kettu Marketplace, by its kept id: the newer version its listing
 * has, or that it was taken down; null for any other item, or one that is current.
 */
export function useCommunityLine(id: string, installed: string | null): string | null {
  const { t } = useTranslation('marketplace')
  const { useMarketplaceStore } = useHostScope()
  const listing = listingIdOf(id)
  const standing = useMarketplaceStore((s) =>
    listing ? s.communityInstalled?.standings[listing] : undefined,
  )
  if (!standing) return null
  if (standing.state === 'taken-down') return t('community.takenDownLine')
  const update = updateFor(standing, installed)
  return update ? t('community.updateLine', { version: update }) : null
}

/** The agents that may get Kettu's tools, those turned off, and the switch that changes one. */
export function useKettuSwitches() {
  const { useAgentsStore, useSettingsStore } = useHostScope()
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const off = useSettingsStore((s) => s.settings.mcp.kettu.off)
  const [error, setError] = useState<string | null>(null)
  const set = (agentId: AgentId, enabled: boolean) => {
    const next = enabled ? off.filter((id) => id !== agentId) : [...off, agentId]
    setError(null)
    useSettingsStore
      .getState()
      .update({ mcp: { kettu: { off: next } } })
      .catch((e: unknown) => setError(errorMessage(e)))
  }
  return { agents, off, error, set }
}

export function useKeptServers(query: string): { server: MarketServer; listing: Listing }[] {
  const scope = useHostScope()
  const { useSettingsStore, useMarketplaceStore } = scope
  const kept = useSettingsStore((s) => s.settings.marketplace.mcp)
  // The catalog gives a kept server its mark, badge and line once it has answered.
  useMarketplaceStore((s) => s.catalog)
  const needle = query.trim().toLocaleLowerCase()
  return kept
    .map((server) => ({ server, listing: listingOf(scope, server) }))
    .filter(({ listing, server }) => matchesQuery(listing, query) || server.name.includes(needle))
}

function listingOf(scope: HostScope, server: MarketServer): Listing {
  const entry = server.source === 'registry' ? catalogEntry(scope, server.id) : null
  return entry ? { ...fromCatalog(entry), title: server.title } : fromKept(server)
}

export function useMcpState(server: MarketServer) {
  const { useMarketplaceStore } = useHostScope()
  const check = useMarketplaceStore((s) => s.mcpChecks[server.id])
  const connection = useConnection(server.id)
  if (check?.state === 'checking') return check
  if (check?.state === 'needs-sign-in' && connection?.state === 'connected') return undefined
  if (oauthFlow(server.spec) && connection && connection.state !== 'connected') {
    return check?.state === 'error' ? check : ({ state: 'needs-sign-in' } as const)
  }
  return check
}

export function useTransportName(spec: McpSpec): string {
  const { t } = useTranslation('marketplace')
  return spec.type === 'stdio' ? t('mcp.command') : t(`listing.transport.${spec.transport}`)
}

const INSIGHT_MS = 5_000

/** The server's insight from its host, read again while the page shows it and when it changes. */
export function useMcpInsight(server: MarketServer): McpServerInsight | null {
  const { request, useMarketplaceStore } = useHostScope()
  const [insight, setInsight] = useState<McpServerInsight | null>(null)
  const toolChanges = useMarketplaceStore((s) => s.mcpToolChanges[server.id])
  const changed = JSON.stringify([
    server.toolsOff,
    server.agents,
    server.spec,
    server.run,
    toolChanges ?? null,
  ])
  useEffect(() => {
    let live = true
    const read = () =>
      request('market.mcpInsight', { serverId: server.id })
        .then((found) => live && setInsight(found[0] ?? null))
        .catch(() => undefined)
    void read()
    const timer = setInterval(() => void read(), INSIGHT_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [request, server.id, changed])
  return insight
}

/** How a server's tools differ from those the user accepted, or null when they do not. */
export function useMcpToolChanges(serverId: string): McpToolChanges | null {
  const { useMarketplaceStore } = useHostScope()
  return useMarketplaceStore((s) => s.mcpToolChanges[serverId] ?? null)
}
