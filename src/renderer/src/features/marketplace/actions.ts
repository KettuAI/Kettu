// What the Marketplace changes: the servers and skills Kettu keeps, in the host settings'
// `marketplace`, each list written whole; the servers' keys, which go to main apart from the
// settings; and the plugins and marketplaces the harnesses keep, through the agent host. Each works
// on the host of the scope it is given.

import type {
  CatalogPlugin,
  CatalogServer,
  InstalledPlugin,
  MarketConnection,
  MarketServer,
  MarketSkill,
  McpSpec,
  PluginMarketplace,
  PluginScope,
  SkillSource,
} from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale, i18n } from '@renderer/lib/i18n'
import { agentName } from '@renderer/stores/agents'
import {
  busyKey,
  setBusy,
  setConnectFlow,
  updatePlugins,
  waitForLogin,
  type ConnectFlow,
} from '@renderer/stores/marketplace'
import type { HostScope } from '@renderer/stores/host-scope'
import { oauthFlow, serverName } from './model'

// Bound to the namespace only: each call reads the language shown at the time.
const t = i18n.getFixedT(null, 'marketplace')

/** Which agents a server goes to. */
export type AgentChoice = MarketServer['agents']

export function keptServers(scope: HostScope): MarketServer[] {
  return scope.useSettingsStore.getState().settings.marketplace.mcp
}

async function save(scope: HostScope, servers: MarketServer[]): Promise<void> {
  await scope.useSettingsStore.getState().update({ marketplace: { mcp: servers } })
}

export function keptSkills(scope: HostScope): MarketSkill[] {
  return scope.useSettingsStore.getState().settings.marketplace.skills
}

async function saveSkills(scope: HostScope, skills: MarketSkill[]): Promise<void> {
  await scope.useSettingsStore.getState().update({ marketplace: { skills } })
}

function warn(text: string): void {
  toast(text, undefined, { tone: 'warning' })
}

/** "every agent", or the chosen agents' names as a list of the language shown. */
function forWhom(scope: HostScope, agents: AgentChoice): string | null {
  if (agents === 'all') return null
  return new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
    agents.map((id) => agentName(id, scope.hostId)),
  )
}

function readyToast(scope: HostScope, name: string, agents: AgentChoice): void {
  const who = forWhom(scope, agents)
  toast(who ? t('toast.readyFor', { name, agents: who }) : t('toast.ready', { name }), undefined, {
    tone: 'success',
  })
}

/** Stores the values a user filled in; true when there were none or they were stored. */
async function storeValues(
  scope: HostScope,
  serverId: string,
  name: string,
  values: Record<string, string>,
): Promise<boolean> {
  const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''))
  if (Object.keys(filled).length === 0) return true
  try {
    await scope.useMarketplaceStore.getState().setKeys({ serverId, values: filled })
    return true
  } catch (e) {
    toast(t('toast.keysNotSaved', { name, error: errorMessage(e) }), undefined, {
      tone: 'warning',
    })
    return false
  }
}

/**
 * Installs a catalog server for `agents` with the values its inputs were given: Kettu keeps it,
 * then its values go to the key store. True once it is kept, even if its keys were not stored.
 */
export async function installServer(
  scope: HostScope,
  server: CatalogServer,
  agents: AgentChoice,
  values: Record<string, string>,
): Promise<boolean> {
  const busy = busyKey('mcp', server.id)
  const market = scope.useMarketplaceStore
  if (market.getState().busy.includes(busy)) return false
  setBusy(market, busy, true)
  try {
    const kept = keptServers(scope).filter((s) => s.id !== server.id)
    const entry: MarketServer = {
      id: server.id,
      name: serverName(server.id, kept),
      title: server.title,
      source: 'registry',
      version: server.version,
      spec: server.spec,
      agents,
      on: true,
    }
    try {
      await save(scope, [...kept, entry])
    } catch (e) {
      toast(t('toast.installFailed', { name: server.title, error: errorMessage(e) }), undefined, {
        tone: 'warning',
      })
      return false
    }
    if (await storeValues(scope, server.id, server.title, values))
      readyToast(scope, server.title, agents)
    return true
  } finally {
    setBusy(scope.useMarketplaceStore, busy, false)
  }
}

/** Adds a server by hand, its secret values to the key store. True once it is kept. */
export async function addServer(
  scope: HostScope,
  name: string,
  spec: McpSpec,
  secrets: Record<string, string>,
): Promise<boolean> {
  const entry: MarketServer = {
    id: `manual:${crypto.randomUUID()}`,
    name,
    title: name,
    source: 'manual',
    version: null,
    spec,
    agents: 'all',
    on: true,
  }
  await save(scope, [...keptServers(scope), entry])
  if (await storeValues(scope, entry.id, name, secrets)) readyToast(scope, name, 'all')
  return true
}

/** Changes one server Kettu keeps; a failure shows as a toast. */
export async function changeServer(
  scope: HostScope,
  id: string,
  change: (server: MarketServer) => MarketServer,
): Promise<void> {
  const kept = keptServers(scope)
  const server = kept.find((s) => s.id === id)
  if (!server) return
  try {
    await save(
      scope,
      kept.map((s) => (s.id === id ? change(s) : s)),
    )
  } catch (e) {
    toast(t('toast.changeFailed', { name: server.title, error: errorMessage(e) }), undefined, {
      tone: 'warning',
    })
  }
}

export function setServerOn(scope: HostScope, id: string, on: boolean): Promise<void> {
  return changeServer(scope, id, (server) => ({ ...server, on }))
}

export function setServerAgents(scope: HostScope, id: string, agents: AgentChoice): Promise<void> {
  return changeServer(scope, id, (server) => ({ ...server, agents }))
}

/** Removes a server Kettu keeps; main clears its keys with it. Throws when it could not. */
export async function uninstallServer(scope: HostScope, id: string): Promise<void> {
  const kept = keptServers(scope)
  const server = kept.find((s) => s.id === id)
  if (!server) return
  await save(
    scope,
    kept.filter((s) => s.id !== id),
  )
  toast(t('toast.uninstalled', { name: server.title }), undefined, { tone: 'success' })
}

/** The agents a server goes to, for a check against one agent. */
export function goesTo(agents: AgentChoice, agentId: AgentId): boolean {
  return agents === 'all' || agents.includes(agentId)
}

/** Installs a plugin into one agent's configuration through its harness. True once installed. */
export async function installPlugin(
  scope: HostScope,
  plugin: CatalogPlugin,
  agentId: AgentId,
  pluginScope: PluginScope,
  projectPath: string | null,
): Promise<boolean> {
  const busy = busyKey('plugin', `${plugin.harness}/${plugin.id}`)
  const market = scope.useMarketplaceStore
  if (market.getState().busy.includes(busy)) return false
  setBusy(market, busy, true)
  try {
    const installed = await scope.request('market.installPlugin', {
      agentId,
      pluginId: plugin.id,
      scope: pluginScope,
      ...(projectPath ? { projectPath } : {}),
    })
    updatePlugins(scope.useMarketplaceStore, (p) => ({
      ...p,
      installed: [...p.installed.filter((x) => !samePlace(x, installed)), installed],
    }))
    toast(
      t('toast.pluginReady', { name: plugin.title, agent: agentName(agentId, scope.hostId) }),
      undefined,
      {
        tone: 'success',
      },
    )
    return true
  } catch (e) {
    warn(t('toast.installFailed', { name: plugin.title, error: errorMessage(e) }))
    return false
  } finally {
    setBusy(scope.useMarketplaceStore, busy, false)
  }
}

/** The same install: one plugin in one agent's configuration, at one scope and project. */
function samePlace(a: InstalledPlugin, b: InstalledPlugin): boolean {
  return (
    a.id === b.id &&
    a.agentId === b.agentId &&
    a.scope === b.scope &&
    (a.projectPath ?? null) === (b.projectPath ?? null)
  )
}

function placeOf(plugin: InstalledPlugin) {
  return {
    agentId: plugin.agentId,
    pluginId: plugin.id,
    scope: plugin.scope,
    ...(plugin.projectPath ? { projectPath: plugin.projectPath } : {}),
  }
}

/** Turns an installed plugin on or off in its agent's configuration; a failure shows as a toast. */
export async function setPluginEnabled(
  scope: HostScope,
  plugin: InstalledPlugin,
  title: string,
  enabled: boolean,
): Promise<void> {
  const busy = busyKey('plugin', `${plugin.agentId}|${plugin.id}|${plugin.scope}`)
  setBusy(scope.useMarketplaceStore, busy, true)
  try {
    await scope.request('market.setPluginEnabled', { ...placeOf(plugin), enabled })
    updatePlugins(scope.useMarketplaceStore, (p) => ({
      ...p,
      installed: p.installed.map((x) => (samePlace(x, plugin) ? { ...x, enabled } : x)),
    }))
  } catch (e) {
    warn(t('toast.changeFailed', { name: title, error: errorMessage(e) }))
  } finally {
    setBusy(scope.useMarketplaceStore, busy, false)
  }
}

/** Uninstalls a plugin from its agent's configuration. Throws when it could not. */
export async function uninstallPlugin(
  scope: HostScope,
  plugin: InstalledPlugin,
  title: string,
): Promise<void> {
  await scope.request('market.uninstallPlugin', placeOf(plugin))
  updatePlugins(scope.useMarketplaceStore, (p) => ({
    ...p,
    installed: p.installed.filter((x) => !samePlace(x, plugin)),
  }))
  toast(
    t('toast.uninstalledFrom', { name: title, agent: agentName(plugin.agentId, scope.hostId) }),
    undefined,
    {
      tone: 'success',
    },
  )
}

/** Adds a plugin marketplace to an agent; its plugins come with the next read. Throws. */
export async function addMarketplace(
  scope: HostScope,
  agentId: AgentId,
  source: string,
): Promise<void> {
  const added = await scope.request('market.addMarketplace', { agentId, source })
  updatePlugins(scope.useMarketplaceStore, (p) => ({
    ...p,
    marketplaces: [
      ...p.marketplaces.filter((m) => !(m.agentId === agentId && m.name === added.name)),
      added,
    ],
  }))
  toast(
    t('toast.marketplaceAdded', { name: added.name, agent: agentName(agentId, scope.hostId) }),
    undefined,
    {
      tone: 'success',
    },
  )
  void scope.useMarketplaceStore.getState().loadPlugins(true)
}

/** Removes a plugin marketplace from its agent. Throws when it could not. */
export async function removeMarketplace(
  scope: HostScope,
  market: PluginMarketplace,
): Promise<void> {
  await scope.request('market.removeMarketplace', { agentId: market.agentId, name: market.name })
  updatePlugins(scope.useMarketplaceStore, (p) => ({
    ...p,
    marketplaces: p.marketplaces.filter(
      (m) => !(m.agentId === market.agentId && m.name === market.name),
    ),
  }))
  toast(t('toast.marketplaceRemoved', { name: market.name }), undefined, { tone: 'success' })
  void scope.useMarketplaceStore.getState().loadPlugins(true)
}

/**
 * Adds a skill for `agents`: the host copies its files, then Kettu keeps it. `busyId` marks the
 * row or listing that asked. True once it is kept.
 */
export async function installSkill(
  scope: HostScope,
  source: SkillSource,
  agents: AgentChoice,
  busyId: string,
): Promise<boolean> {
  const busy = busyKey('skill', busyId)
  const market = scope.useMarketplaceStore
  if (market.getState().busy.includes(busy)) return false
  setBusy(market, busy, true)
  try {
    const skill = await scope.request('market.addSkill', { source })
    const entry: MarketSkill = { ...skill, agents, on: true }
    await saveSkills(scope, [...keptSkills(scope).filter((s) => s.id !== entry.id), entry])
    readyToast(scope, entry.name, agents)
    return true
  } catch (e) {
    warn(t('toast.skillFailed', { error: errorMessage(e) }))
    return false
  } finally {
    setBusy(scope.useMarketplaceStore, busy, false)
  }
}

/** Changes one skill Kettu keeps; a failure shows as a toast. */
async function changeSkill(
  scope: HostScope,
  id: string,
  change: (skill: MarketSkill) => MarketSkill,
): Promise<void> {
  const kept = keptSkills(scope)
  const skill = kept.find((s) => s.id === id)
  if (!skill) return
  try {
    await saveSkills(
      scope,
      kept.map((s) => (s.id === id ? change(s) : s)),
    )
  } catch (e) {
    warn(t('toast.changeFailed', { name: skill.name, error: errorMessage(e) }))
  }
}

export function setSkillOn(scope: HostScope, id: string, on: boolean): Promise<void> {
  return changeSkill(scope, id, (skill) => ({ ...skill, on }))
}

export function setSkillAgents(scope: HostScope, id: string, agents: AgentChoice): Promise<void> {
  return changeSkill(scope, id, (skill) => ({ ...skill, agents }))
}

/** Removes a skill Kettu keeps. Throws when it could not. */
export async function removeSkill(scope: HostScope, id: string): Promise<void> {
  const kept = keptSkills(scope)
  const skill = kept.find((s) => s.id === id)
  if (!skill) return
  await saveSkills(
    scope,
    kept.filter((s) => s.id !== id),
  )
  toast(t('toast.uninstalled', { name: skill.name }), undefined, { tone: 'success' })
}

/** How long a Connect waits for the sign-in at the service before it gives up. */
const LOGIN_TIMEOUT_MS = 5 * 60_000

function flowOf(scope: HostScope, serverId: string): ConnectFlow | null {
  return scope.useMarketplaceStore.getState().connecting[serverId] ?? null
}

/** An http(s) page in the system browser, as the app opens every outside link. */
export function openPage(url: string): void {
  window.open(url, '_blank', 'noreferrer')
}

/** Why a sign-in did not end connected, in the words its state gives. */
export function connectionProblem(connection: MarketConnection): string | null {
  if (connection.state === 'error') return connection.message
  if (connection.state === 'needs-reconnect') return connection.reason
  return null
}

/** Takes a server that a Connect added out of the settings again. */
async function dropFresh(scope: HostScope, serverId: string, title: string): Promise<void> {
  try {
    await save(
      scope,
      keptServers(scope).filter((s) => s.id !== serverId),
    )
  } catch (e) {
    warn(t('toast.changeFailed', { name: title, error: errorMessage(e) }))
  }
}

/** Ends a Connect as failed: the popover shows why, and a server it added goes again. */
async function failConnect(
  scope: HostScope,
  serverId: string,
  title: string,
  error: string,
): Promise<void> {
  const flow = flowOf(scope, serverId)
  if (!flow) return
  if (flow.fresh) await dropFresh(scope, serverId, title)
  setConnectFlow(scope.useMarketplaceStore, serverId, {
    ...flow,
    fresh: false,
    phase: 'failed',
    start: null,
    error,
  })
}

/**
 * Whether a Connect can finish from this window: a browser sign-in comes back to a loopback port
 * of the host, which a browser on this device cannot reach when the host is another computer.
 */
export function connectsHere(scope: HostScope, spec: McpSpec): boolean {
  return scope.hostId === null || oauthFlow(spec) !== 'browser'
}

/**
 * Connects a server that signs in with OAuth. A catalog server is installed for `agents` first,
 * since connecting is installing; a kept one only signs in again. The browser page opens at once;
 * the device code shows in the popover. A Connect that fails, is cancelled or takes longer than
 * five minutes takes a server it added out again.
 */
export async function connectServer(
  scope: HostScope,
  server: CatalogServer | MarketServer,
  agents: AgentChoice,
): Promise<void> {
  const serverId = server.id
  const current = flowOf(scope, serverId)
  if (current && current.phase !== 'failed') return
  if (!connectsHere(scope, server.spec)) {
    setConnectFlow(scope.useMarketplaceStore, serverId, {
      serverId,
      fresh: false,
      phase: 'failed',
      start: null,
      error: t('connect.browserOnHost'),
    })
    return
  }
  setConnectFlow(scope.useMarketplaceStore, serverId, {
    serverId,
    fresh: false,
    phase: 'starting',
    start: null,
    error: null,
  })
  const kept = keptServers(scope)
  if (!kept.some((s) => s.id === serverId) && 'publisher' in server) {
    // Marked before it is saved, so its Connect button stays while the server turns kept.
    setConnectFlow(scope.useMarketplaceStore, serverId, {
      ...flowOf(scope, serverId)!,
      fresh: true,
    })
    const others = kept.filter((s) => s.id !== serverId)
    try {
      await save(scope, [
        ...others,
        {
          id: serverId,
          name: serverName(serverId, others),
          title: server.title,
          source: 'registry',
          version: server.version,
          spec: server.spec,
          agents,
          on: true,
        },
      ])
    } catch (e) {
      setConnectFlow(scope.useMarketplaceStore, serverId, {
        serverId,
        fresh: false,
        phase: 'failed',
        start: null,
        error: errorMessage(e),
      })
      return
    }
    // Cancelled while it was saved: the cancel found nothing to take out yet.
    if (!flowOf(scope, serverId)) return dropFresh(scope, serverId, server.title)
  }

  let start
  try {
    start = await scope.request('market.connect', { serverId })
  } catch (e) {
    return failConnect(scope, serverId, server.title, errorMessage(e))
  }
  const flow = flowOf(scope, serverId)
  // Cancelled while the host was asked: the sign-in it began is let go at once.
  if (!flow || flow.phase !== 'starting') return cancelLogin(scope, start.loginId)
  setConnectFlow(scope.useMarketplaceStore, serverId, { ...flow, phase: 'waiting', start })
  if (start.kind === 'browser') openPage(start.url)

  const end = await waitForLogin(start.loginId, LOGIN_TIMEOUT_MS)
  // Cancelled, or another Connect began meanwhile.
  if (flowOf(scope, serverId)?.start?.loginId !== start.loginId) return
  if (!end) {
    cancelLogin(scope, start.loginId)
    return failConnect(scope, serverId, server.title, t('connect.timedOut'))
  }
  if (end.connection.state !== 'connected') {
    const why = end.error ?? connectionProblem(end.connection) ?? t('connect.notConnected')
    return failConnect(scope, serverId, server.title, why)
  }
  setConnectFlow(scope.useMarketplaceStore, serverId, null)
  toast(t('toast.connected', { name: server.title }), undefined, { tone: 'success' })
}

function cancelLogin(scope: HostScope, loginId: string): void {
  scope
    .request('market.cancelConnect', { loginId })
    .catch((e: unknown) => console.warn(`Could not cancel a sign-in: ${errorMessage(e)}`))
}

/** Stops a Connect under way; a server it added goes again. */
export async function cancelConnect(
  scope: HostScope,
  serverId: string,
  title: string,
): Promise<void> {
  const flow = flowOf(scope, serverId)
  if (!flow) return
  setConnectFlow(scope.useMarketplaceStore, serverId, null)
  if (flow.start) cancelLogin(scope, flow.start.loginId)
  if (flow.fresh) await dropFresh(scope, serverId, title)
}

/** Forgets a Connect that failed, once its popover closes. */
export function dismissConnect(scope: HostScope, serverId: string): void {
  if (flowOf(scope, serverId)?.phase === 'failed')
    setConnectFlow(scope.useMarketplaceStore, serverId, null)
}

/** Clears a server's tokens and keeps the server; every agent loses it at once. */
export async function disconnectServer(scope: HostScope, server: MarketServer): Promise<void> {
  try {
    await scope.request('market.disconnect', { serverId: server.id })
    scope.useMarketplaceStore.setState((s) =>
      s.connections
        ? { connections: { ...s.connections, [server.id]: { state: 'disconnected' } } }
        : s,
    )
    toast(t('toast.disconnected', { name: server.title }), undefined, { tone: 'success' })
  } catch (e) {
    warn(t('toast.disconnectFailed', { name: server.title, error: errorMessage(e) }))
  }
}
