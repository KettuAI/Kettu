// The hooks of Kettu plugins in the Marketplace: reading the installed ones, starting an install,
// and the names an item shows for where it came from.

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InstalledKettuPlugin, PluginPlan, PluginSource } from '@shared/plugins'
import { pluginItem } from '@shared/plugins'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale, i18n } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import { setBusy as markBusy } from '@renderer/stores/marketplace'
import { openMarketplace, type MarketplaceTab } from '@renderer/stores/view'
import { useBusy } from './hooks'
import { itemKey } from './model'
import { inspectPlugin, pluginBusy, sourceKey } from './plugin-actions'
import { githubShort, pluginTitle } from './plugin-model'
import { PluginConsent, type PluginInstall, type PluginMeta } from './plugin-install'

// Bound to the namespace only: each call reads the language shown at the time.
const tm = i18n.getFixedT(null, 'marketplace')

interface Waiting {
  plan: PluginPlan
  meta: PluginMeta
  onInstalled?: (plugin: InstalledKettuPlugin) => void
}

/**
 * Starts the install of a source: the host reads the package, then the consent card shows what it
 * holds. `dialogs` is the card, which the caller draws once. `start` answers whether the card
 * is showing, and says why on a toast when it is not.
 */
export function usePluginInstall(): PluginInstall {
  const scope = useHostScope()
  const [waiting, setWaiting] = useState<Waiting | null>(null)
  // The sources being read, since a second tap must not start a second read.
  const reading = useRef(new Set<string>())
  const start = async (
    source: PluginSource,
    options: { meta?: PluginMeta; onInstalled?: (plugin: InstalledKettuPlugin) => void } = {},
  ): Promise<boolean> => {
    const key = sourceKey(source)
    if (reading.current.has(key)) return false
    reading.current.add(key)
    const market = scope.useMarketplaceStore
    markBusy(market, pluginBusy(key), true)
    try {
      const plan = await inspectPlugin(scope, source)
      setWaiting({ plan, meta: options.meta ?? {}, onInstalled: options.onInstalled })
      return true
    } catch (error) {
      toast(tm('plugin.toast.inspectFailed', { error: errorMessage(error) }), undefined, {
        tone: 'warning',
      })
      return false
    } finally {
      reading.current.delete(key)
      markBusy(market, pluginBusy(key), false)
    }
  }
  return {
    start,
    dialogs: waiting && (
      <PluginConsent
        key={waiting.plan.token}
        plan={waiting.plan}
        meta={waiting.meta}
        onInstalled={waiting.onInstalled}
        onClose={() => setWaiting(null)}
      />
    ),
  }
}

/** Whether a source's package is being read, for the control that asked. */
export function useSourceReading(source: PluginSource): boolean {
  return useBusy(pluginBusy(sourceKey(source)))
}

/** The plugins installed on this host; null until it has answered. */
export function useInstalledPlugins(): InstalledKettuPlugin[] | null {
  const { useMarketplaceStore } = useHostScope()
  return useMarketplaceStore((s) => s.plugins)
}

/** The plugin installed from a listing of the Kettu Marketplace, if there is one. */
export function usePluginOfListing(listingId: string): InstalledKettuPlugin | null {
  const plugins = useInstalledPlugins()
  return (
    plugins?.find((plugin) => plugin.source.kind === 'kettu' && plugin.source.id === listingId) ??
    null
  )
}

/** Who a plugin comes from: its listing's publisher, a repository's owner, or its author. */
export function usePluginPublisher(): (plugin: InstalledKettuPlugin) => string {
  const { t } = useTranslation('marketplace')
  return (plugin) => {
    const { source } = plugin
    if (source.kind === 'kettu') {
      return /^@([^/]+)\//.exec(plugin.origin ?? '')?.[1] ?? t('community.source')
    }
    if (source.kind === 'github') {
      return URL.parse(source.url)?.pathname.split('/')[1] || githubShort(source.url)
    }
    return plugin.contents.author ?? t('plugin.install.fromFolder')
  }
}

/** Opens a plugin's page, from the tab it was opened on. */
export function openPlugin(id: string, tab: MarketplaceTab): void {
  openMarketplace({ item: itemKey({ kind: 'plugin', id }), tab })
}

/** The plugin an item of the skills or servers Kettu keeps came with, by the item's kept id. */
export function usePluginOfItem(id: string): { plugin: InstalledKettuPlugin | null } | null {
  const plugins = useInstalledPlugins()
  const item = pluginItem(id)
  if (!item) return null
  return { plugin: plugins?.find((plugin) => plugin.id === item.pluginId) ?? null }
}

/** Whether an item came with a plugin that is off, which keeps the item off until it is on. */
export function usePluginItemOff(id: string): boolean {
  return usePluginOfItem(id)?.plugin?.enabled === false
}

/** A plugin's name as shown, by its id: its title when it is installed here, else `fallback`. */
export function usePluginName(pluginId: string, fallback: string): string {
  const plugins = useInstalledPlugins()
  const plugin = plugins?.find((item) => item.id === pluginId)
  return plugin ? pluginTitle(plugin.contents, currentLocale()) : fallback
}
