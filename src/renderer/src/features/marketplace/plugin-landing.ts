// The ways onto a plugin's page: from a search result or an agent's open_settings at one of its
// rows, from Set up at its first missing setting, and from an install, which lands there.

import { create } from 'zustand'
import type { InstalledKettuPlugin } from '@shared/plugins'
import type { CatalogSection } from '@shared/settings-catalog'
import { openHostSettingsRow } from '@renderer/features/settings/host-sections'
import {
  openMarketplace,
  openSettingsRow,
  useViewStore,
  type MarketplaceTab,
  type SessionView,
} from '@renderer/stores/view'
import { itemKey } from './model'

/** What a way onto the page asks of it. */
export interface PluginLanding {
  /** A row to show, which flashes as a search result does. */
  row?: string
  /** Puts the caret in the first required setting that is empty. */
  setup?: boolean
  /** The plugin was just installed, which a toast says with what it still needs. */
  installed?: boolean
}

type StoredLanding = PluginLanding & {
  /** The host the landing belongs to (null for this computer); omitted matches any host. */
  hostId?: string | null
}

const useLandings = create<{ byId: Record<string, StoredLanding> }>()(() => ({ byId: {} }))

function matchesHost(landing: StoredLanding | undefined, hostId: string | null): boolean {
  return landing !== undefined && (landing.hostId === undefined || landing.hostId === hostId)
}

/** The pending landing for `id` on `hostId`, if one matches; undefined otherwise. */
export function pluginLandingFor(id: string, hostId: string | null): PluginLanding | undefined {
  const entry = useLandings.getState().byId[id]
  return matchesHost(entry, hostId) ? entry : undefined
}

/** What waits for the plugin's page on `hostId` to take it; undefined once taken. */
export function usePluginLanding(
  id: string | null,
  hostId: string | null = null,
): PluginLanding | undefined {
  return useLandings((s) => {
    if (id === null) return undefined
    const entry = s.byId[id]
    return matchesHost(entry, hostId) ? entry : undefined
  })
}

export function takePluginLanding(id: string, hostId: string | null = null): void {
  useLandings.setState((s) => {
    if (!matchesHost(s.byId[id], hostId)) return s
    const rest = { ...s.byId }
    delete rest[id]
    return { byId: rest }
  })
}

function land(id: string, hostId: string | null | undefined, landing: PluginLanding): void {
  const stored: StoredLanding = hostId === undefined ? landing : { ...landing, hostId }
  useLandings.setState((s) => ({ byId: { ...s.byId, [id]: stored } }))
}

function show(id: string, tab: MarketplaceTab, from?: SessionView, hostId?: string | null): void {
  openMarketplace({ item: itemKey({ kind: 'plugin', id }), tab, from, hostId })
}

/**
 * Opens a plugin's page; with `row`, at that row, and with `setup`, at its first missing setting.
 * With `hostId` (null being this computer), pins the Marketplace page to that host instead of the
 * window's host. Opened `from` a session, the page's Back returns to it.
 */
export function openPluginPage(
  id: string,
  options: {
    tab?: MarketplaceTab
    row?: string
    setup?: boolean
    from?: SessionView
    hostId?: string | null
  } = {},
): void {
  const { tab = 'installed', from, hostId, ...landing } = options
  if (landing.row || landing.setup) land(id, hostId, landing)
  show(id, tab, from, hostId)
}

/**
 * Where an install lands: on the plugin's page. A listing installed from its own page stays there,
 * since that page turns into the plugin's; any other install opens it.
 */
export function landOnPlugin(plugin: InstalledKettuPlugin, hostId?: string | null): void {
  land(plugin.id, hostId, { setup: true, installed: true })
  const main = useViewStore.getState().main
  const tab = main.kind === 'marketplace' ? (main.tab ?? 'installed') : 'installed'
  const listing =
    plugin.source.kind === 'kettu' ? itemKey({ kind: 'community', id: plugin.source.id }) : null
  if (main.kind === 'marketplace' && listing !== null && main.item === listing) return
  const targetHost = main.kind === 'marketplace' ? main.hostId : hostId
  show(plugin.id, tab === 'all' ? 'installed' : tab, undefined, targetHost)
}

/**
 * Opens where a settings catalog row lives: a plugin's setting on the plugin's page, any other row
 * in Settings. Older thread lines name a plugin's settings `plugins`, the section they had.
 */
export function openCatalogRow(
  section: CatalogSection,
  item: string | null,
  row: string,
  hostId?: string | null,
): void {
  if (section === 'marketplace' || (section as string) === 'plugins') {
    if (item !== null) openPluginPage(item, { row, hostId })
    return
  }
  if (hostId !== undefined) openHostSettingsRow(hostId, section, item, row)
  else openSettingsRow(section, item, row)
}
