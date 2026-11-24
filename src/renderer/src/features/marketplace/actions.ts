// What the Marketplace changes: the servers and skills Kettu keeps, in the host settings'
// `marketplace`, each change an edit the host applies to its own list; and the servers' keys, which
// go to main apart from the settings. Each works on the host of the scope it is given.

import {
  serverName,
  type CatalogServer,
  type MarketConnection,
  type MarketServer,
  type MarketSkill,
  type McpSpec,
  type SkillSource,
} from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import { listingIdOf } from '@shared/market-community'
import { applyListEdit, type ListEdit } from '@shared/settings'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale, i18n } from '@renderer/lib/i18n'
import { agentName } from '@renderer/stores/agents'
import {
  busyKey,
  setBusy,
  setConnectFlow,
  waitForLogin,
  type ConnectFlow,
} from '@renderer/stores/marketplace'
import type { HostScope } from '@renderer/stores/host-scope'
import { oauthFlow } from './model'

// Bound to the namespace only: each call reads the language shown at the time.
const t = i18n.getFixedT(null, 'marketplace')

/** Which agents a server goes to. */
export type AgentChoice = MarketServer['agents']

/** Where a catalog server comes from: the Kettu Marketplace by its id, else the registry. */
function sourceOf(server: CatalogServer): MarketServer['source'] {
  return listingIdOf(server.id) ? 'kettu' : 'registry'
}

/** The name agents call a server by, from its registry name, or its title for a listing's. */
function nameOf(server: CatalogServer, kept: MarketServer[]): string {
  return serverName(listingIdOf(server.id) ? server.title : server.id, kept)
}

export function keptServers(scope: HostScope): MarketServer[] {
  return scope.useSettingsStore.getState().settings.marketplace.mcp
}

// What a host that takes only whole lists answers to an edit.
const NO_EDITS = /Unknown setting "marketplace\.(mcpEdit|skillsEdit)"/

/**
 * Changes the servers Kettu keeps as an edit of the host's own list, so installs and removals
 * made together, here or from another device, never drop each other. A host too old to take an
 * edit gets the list written whole.
 */
async function editServers(scope: HostScope, edit: ListEdit<MarketServer>): Promise<void> {
  const { update } = scope.useSettingsStore.getState()
  try {
    await update({ marketplace: { mcpEdit: edit } })
  } catch (e) {
    if (!NO_EDITS.test(errorMessage(e))) throw e
    await update({ marketplace: { mcp: applyListEdit(keptServers(scope), edit) } })
  }
}

export function keptSkills(scope: HostScope): MarketSkill[] {
  return scope.useSettingsStore.getState().settings.marketplace.skills
}

/** The same for the skills Kettu keeps. */
async function editSkills(scope: HostScope, edit: ListEdit<MarketSkill>): Promise<void> {
  const { update } = scope.useSettingsStore.getState()
  try {
    await update({ marketplace: { skillsEdit: edit } })
  } catch (e) {
    if (!NO_EDITS.test(errorMessage(e))) throw e
    await update({ marketplace: { skills: applyListEdit(keptSkills(scope), edit) } })
  }
}

function warn(text: string): void {
  toast(text, undefined, { tone: 'warning' })
}

/** A failed install, whose form is gone: the toast offers it again. */
function warnRetry(text: string, retry: () => void): void {
  toast(text, { label: i18n.t('common:actions.retry'), onClick: retry }, { tone: 'warning' })
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
      name: nameOf(server, kept),
      title: server.title,
      source: sourceOf(server),
      version: server.version,
      spec: server.spec,
      agents,
      on: true,
    }
    try {
      await editServers(scope, { put: [entry] })
    } catch (e) {
      warnRetry(
        t('toast.installFailed', { name: server.title, error: errorMessage(e) }),
        () => void installServer(scope, server, agents, values),
      )
      return false
    }
    if (await storeValues(scope, server.id, server.title, values))
      readyToast(scope, server.title, agents)
    return true
  } finally {
    setBusy(scope.useMarketplaceStore, busy, false)
  }
}

/**
 * The spec of a URL being added, with the OAuth flow it signs in with, if any, as the host finds
 * by asking it with the headers typed. Only Streamable HTTP is asked, the one the proxy speaks.
 * When it cannot be asked, the server is kept as typed and a toast says so.
 */
async function withSignIn(
  scope: HostScope,
  name: string,
  spec: McpSpec,
  secrets: Record<string, string>,
): Promise<McpSpec> {
  if (spec.type !== 'http' || spec.transport !== 'streamable-http') return spec
  const headers = spec.headers.flatMap((header) => {
    if (!('input' in header)) return [{ name: header.name, value: header.value }]
    const value = secrets[header.name]
    return value ? [{ name: header.name, value }] : []
  })
  try {
    const { oauth } = await scope.request('market.detectSignIn', { url: spec.url, headers })
    return oauth ? { ...spec, oauth } : spec
  } catch (e) {
    warn(t('toast.signInUnchecked', { name, error: errorMessage(e) }))
    return spec
  }
}

/**
 * Adds a server by hand, its secret values to the key store. One that signs in with OAuth starts
 * its Connect at once, and stays kept if that does not finish, since the user typed it in. True
 * once it is kept.
 */
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
    spec: await withSignIn(scope, name, spec, secrets),
    agents: 'all',
    on: true,
  }
  await editServers(scope, { put: [entry] })
  const stored = await storeValues(scope, entry.id, name, secrets)
  if (oauthFlow(entry.spec)) void connectServer(scope, entry, 'all')
  else if (stored) readyToast(scope, name, 'all')
  return true
}

/** Changes one server Kettu keeps; a failure shows as a toast. */
export async function changeServer(
  scope: HostScope,
  id: string,
  change: (server: MarketServer) => MarketServer,
): Promise<void> {
  const server = keptServers(scope).find((s) => s.id === id)
  if (!server) return
  try {
    await editServers(scope, { put: [change(server)] })
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
  const server = keptServers(scope).find((s) => s.id === id)
  if (!server) return
  await editServers(scope, { remove: [id] })
  toast(t('toast.uninstalled', { name: server.title }), undefined, { tone: 'success' })
}

/** The agents a server goes to, for a check against one agent. */
export function goesTo(agents: AgentChoice, agentId: AgentId): boolean {
  return agents === 'all' || agents.includes(agentId)
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
    await editSkills(scope, { put: [entry] })
    readyToast(scope, entry.name, agents)
    return true
  } catch (e) {
    warnRetry(
      t('toast.skillFailed', { error: errorMessage(e) }),
      () => void installSkill(scope, source, agents, busyId),
    )
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
  const skill = keptSkills(scope).find((s) => s.id === id)
  if (!skill) return
  try {
    await editSkills(scope, { put: [change(skill)] })
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
  const skill = keptSkills(scope).find((s) => s.id === id)
  if (!skill) return
  await editSkills(scope, { remove: [id] })
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
    await editServers(scope, { remove: [serverId] })
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
      await editServers(scope, {
        put: [
          {
            id: serverId,
            name: nameOf(server, others),
            title: server.title,
            source: sourceOf(server),
            version: server.version,
            spec: server.spec,
            agents,
            on: true,
          },
        ],
      })
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

/** Reads again where what came from the Kettu Marketplace stands, after it changed. */
function communityChanged(scope: HostScope): void {
  void scope.useMarketplaceStore.getState().loadCommunityInstalled(true)
}

/** Updates a skill from the Kettu Marketplace to its listing's version, keeping its choices. */
export async function updateCommunitySkill(scope: HostScope, kept: MarketSkill): Promise<void> {
  const listing = listingIdOf(kept.id)
  if (!listing) return
  const busy = busyKey('community', listing)
  const market = scope.useMarketplaceStore
  if (market.getState().busy.includes(busy)) return
  setBusy(market, busy, true)
  try {
    const skill = await scope.request('market.addSkill', { source: { kind: 'kettu', id: listing } })
    const current = keptSkills(scope).find((s) => s.id === kept.id)
    if (current) {
      await editSkills(scope, { put: [{ ...skill, agents: current.agents, on: current.on }] })
    }
    communityChanged(scope)
    toast(t('toast.updated', { name: skill.name, version: skill.version ?? '' }), undefined, {
      tone: 'success',
    })
  } catch (e) {
    warnRetry(
      t('toast.updateFailed', { name: kept.name, error: errorMessage(e) }),
      () => void updateCommunitySkill(scope, kept),
    )
  } finally {
    setBusy(market, busy, false)
  }
}

/** Updates a server from the Kettu Marketplace to what its listing now runs, keeping its choices. */
export async function updateCommunityServer(
  scope: HostScope,
  kept: MarketServer,
  server: CatalogServer,
  values: Record<string, string> = {},
): Promise<void> {
  try {
    const current = keptServers(scope).find((s) => s.id === kept.id)
    if (current) {
      await editServers(scope, {
        put: [{ ...current, title: server.title, version: server.version, spec: server.spec }],
      })
    }
    communityChanged(scope)
    if (!(await storeValues(scope, kept.id, server.title, values))) return
    toast(t('toast.updated', { name: server.title, version: server.version }), undefined, {
      tone: 'success',
    })
  } catch (e) {
    warn(t('toast.updateFailed', { name: kept.title, error: errorMessage(e) }))
  }
}

/** Sends a short report on a listing to the Kettu Marketplace. Throws when it could not. */
export async function reportCommunity(
  scope: HostScope,
  id: string,
  message: string,
): Promise<void> {
  await scope.request('market.reportCommunity', { id, message })
  toast(t('toast.reported'), undefined, { tone: 'success' })
}
