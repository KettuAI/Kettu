// The ways onto a plugin's page: from a search result or an agent's open_settings at one of its
// rows, from Set up at its first missing setting, and from an install, which lands there.

import { create } from 'zustand'
import type { InstalledKettuPlugin } from '@shared/plugins'
import type { CatalogSection } from '@shared/settings-catalog'
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

const useLandings = create<{ byId: Record<string, PluginLanding> }>()(() => ({ byId: {} }))

/** What waits for the plugin's page to take it; undefined once taken. */
export function usePluginLanding(id: string | null): PluginLanding | undefined {
  return useLandings((s) => (id === null ? undefined : s.byId[id]))
}

export function takePluginLanding(id: string): void {
  useLandings.setState((s) => {
    const rest = { ...s.byId }
    delete rest[id]
    return { byId: rest }
  })
}

function land(id: string, landing: PluginLanding): void {
  useLandings.setState((s) => ({ byId: { ...s.byId, [id]: landing } }))
}

function show(id: string, tab: MarketplaceTab, from?: SessionView): void {
  openMarketplace({ item: itemKey({ kind: 'plugin', id }), tab, from })
}

/**
 * Opens a plugin's page; with `row`, at that row, and with `setup`, at its first missing setting.
 * Opened `from` a session, the page's Back returns to it.
 */
export function openPluginPage(
  id: string,
  options: { tab?: MarketplaceTab; row?: string; setup?: boolean; from?: SessionView } = {},
): void {
  const { tab = 'installed', from, ...landing } = options
  if (landing.row || landing.setup) land(id, landing)
  show(id, tab, from)
}

/**
 * Where an install lands: on the plugin's page. A listing installed from its own page stays there,
 * since that page turns into the plugin's; any other install opens it.
 */
export function landOnPlugin(plugin: InstalledKettuPlugin): void {
  land(plugin.id, { setup: true, installed: true })
  const main = useViewStore.getState().main
  const tab = main.kind === 'marketplace' ? (main.tab ?? 'installed') : 'installed'
  const listing =
    plugin.source.kind === 'kettu' ? itemKey({ kind: 'community', id: plugin.source.id }) : null
  if (main.kind === 'marketplace' && listing !== null && main.item === listing) return
  show(plugin.id, tab === 'all' ? 'installed' : tab)
}

/**
 * Opens where a settings catalog row lives: a plugin's setting on the plugin's page, any other row
 * in Settings. Older thread lines name a plugin's settings `plugins`, the section they had.
 */
export function openCatalogRow(section: CatalogSection, item: string | null, row: string): void {
  if (section === 'marketplace' || (section as string) === 'plugins') {
    if (item !== null) openPluginPage(item, { row })
    return
  }
  openSettingsRow(section, item, row)
}
