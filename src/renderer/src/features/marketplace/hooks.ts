import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { MarketConnection } from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import { agentName, menuAgents, usableAgents } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { busyKey } from '@renderer/stores/marketplace'
import { count } from '@renderer/lib/format'
import { listingIdOf } from '@shared/market-community'
import { errorMessage } from '@renderer/lib/host'
import { updateFor } from './model'

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
