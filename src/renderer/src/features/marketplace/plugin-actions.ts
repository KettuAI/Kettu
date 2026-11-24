// What the Marketplace does with Kettu's plugins: inspecting a package, installing what the user
// confirmed, and changing an installed one. Each works on the host of the scope it is given.

import type { InstalledKettuPlugin, PluginPlan, PluginSource } from '@shared/plugins'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { currentLocale, i18n } from '@renderer/lib/i18n'
import type { HostScope } from '@renderer/stores/host-scope'
import { busyKey, setBusy } from '@renderer/stores/marketplace'
import { pluginTitle } from './plugin-model'

// Bound to the namespace only: each call reads the language shown at the time.
const t = i18n.getFixedT(null, 'marketplace')

/** The key a plugin's busy state is kept under: its id, or its source before it has one. */
export function pluginBusy(key: string): string {
  return busyKey('plugin', key)
}

/** A source's stable name, which busy states and the add controls share. */
export function sourceKey(source: PluginSource): string {
  return source.kind === 'local'
    ? `local:${source.path}`
    : source.kind === 'github'
      ? `github:${source.url}`
      : `kettu:${source.id}`
}

/** Reads a package without installing anything; the answer waits for the user's confirmation. */
export function inspectPlugin(scope: HostScope, source: PluginSource): Promise<PluginPlan> {
  return scope.request('plugins.inspect', { source })
}

/** Forgets an inspected package the user did not install. */
export function discardPlan(scope: HostScope, token: string): void {
  scope.request('plugins.discard', { token }).catch((error: unknown) => {
    console.warn(`Could not discard an inspected plugin: ${errorMessage(error)}`)
  })
}

/** Installs the package a plan named. Throws why it could not, which the consent shows. */
export async function installPlan(
  scope: HostScope,
  plan: PluginPlan,
): Promise<InstalledKettuPlugin> {
  const plugin = await scope.request('plugins.install', { token: plan.token })
  scope.useMarketplaceStore.getState().putPlugin(plugin)
  void scope.useMarketplaceStore.getState().loadCommunityInstalled(true)
  toast(
    t('plugin.toast.installed', { name: pluginTitle(plugin.contents, currentLocale()) }),
    undefined,
    { tone: 'success' },
  )
  return plugin
}

function warn(text: string): void {
  toast(text, undefined, { tone: 'warning' })
}

/** Runs one change of an installed plugin; a failure shows as a toast. Null when it failed. */
async function change(
  scope: HostScope,
  plugin: InstalledKettuPlugin,
  run: () => Promise<InstalledKettuPlugin>,
  failure: 'toast.changeFailed' | 'plugin.toast.reloadFailed' | 'plugin.toast.rollBackFailed',
): Promise<InstalledKettuPlugin | null> {
  const market = scope.useMarketplaceStore
  const busy = pluginBusy(plugin.id)
  if (market.getState().busy.includes(busy)) return null
  setBusy(market, busy, true)
  try {
    const next = await run()
    market.getState().putPlugin(next)
    return next
  } catch (error) {
    warn(
      t(failure, {
        name: pluginTitle(plugin.contents, currentLocale()),
        error: errorMessage(error),
      }),
    )
    return null
  } finally {
    setBusy(market, busy, false)
  }
}

export function setPluginOn(
  scope: HostScope,
  plugin: InstalledKettuPlugin,
  enabled: boolean,
): Promise<InstalledKettuPlugin | null> {
  return change(
    scope,
    plugin,
    () => scope.request('plugins.setEnabled', { pluginId: plugin.id, enabled }),
    'toast.changeFailed',
  )
}

export async function reloadPlugin(scope: HostScope, plugin: InstalledKettuPlugin): Promise<void> {
  const next = await change(
    scope,
    plugin,
    () => scope.request('plugins.reload', { pluginId: plugin.id }),
    'plugin.toast.reloadFailed',
  )
  if (next) {
    toast(
      t('plugin.toast.reloaded', { name: pluginTitle(next.contents, currentLocale()) }),
      undefined,
      { tone: 'success' },
    )
  }
}

/** Looks for a newer version of one plugin; says what it found. */
export async function checkPluginUpdate(
  scope: HostScope,
  plugin: InstalledKettuPlugin,
): Promise<void> {
  const market = scope.useMarketplaceStore
  const busy = pluginBusy(plugin.id)
  if (market.getState().busy.includes(busy)) return
  setBusy(market, busy, true)
  const name = pluginTitle(plugin.contents, currentLocale())
  try {
    const { plugins } = await scope.request('plugins.checkUpdates', { pluginId: plugin.id })
    for (const item of plugins) market.getState().putPlugin(item)
    const now = plugins.find((item) => item.id === plugin.id)
    if (now?.updateError) {
      warn(t('plugin.toast.updateCheckFailed', { name, error: now.updateError }))
    } else if (now?.held) {
      toast(t('plugin.toast.updateHeld', { name }), undefined, { tone: 'success' })
    } else if (now && now.revision !== plugin.revision) {
      toast(t('plugin.toast.updated', { name, version: now.contents.version ?? '' }), undefined, {
        tone: 'success',
      })
    } else {
      toast(t('plugin.toast.upToDate', { name }), undefined, { tone: 'success' })
    }
  } catch (error) {
    warn(t('plugin.toast.updateCheckFailed', { name, error: errorMessage(error) }))
  } finally {
    setBusy(market, busy, false)
  }
}

/** Installs the held update the user agreed to. Throws why it could not, which the card shows. */
export async function applyHeldUpdate(
  scope: HostScope,
  plugin: InstalledKettuPlugin,
): Promise<void> {
  try {
    const next = await scope.request('plugins.applyUpdate', { pluginId: plugin.id })
    scope.useMarketplaceStore.getState().putPlugin(next)
    toast(
      t('plugin.toast.updated', {
        name: pluginTitle(next.contents, currentLocale()),
        version: next.contents.version ?? '',
      }),
      undefined,
      { tone: 'success' },
    )
  } catch (error) {
    // The update may have grown since it was shown; the plugin is read again so the card says so.
    void scope.useMarketplaceStore.getState().loadPlugins()
    throw error
  }
}

export async function declineHeldUpdate(
  scope: HostScope,
  plugin: InstalledKettuPlugin,
): Promise<void> {
  await change(
    scope,
    plugin,
    () => scope.request('plugins.declineUpdate', { pluginId: plugin.id }),
    'toast.changeFailed',
  )
}

export async function rollBackPlugin(
  scope: HostScope,
  plugin: InstalledKettuPlugin,
): Promise<void> {
  const next = await change(
    scope,
    plugin,
    () => scope.request('plugins.rollBack', { pluginId: plugin.id }),
    'plugin.toast.rollBackFailed',
  )
  if (next) {
    toast(
      t('plugin.toast.rolledBack', {
        name: pluginTitle(next.contents, currentLocale()),
        version: next.contents.version ?? '',
      }),
      undefined,
      { tone: 'success' },
    )
  }
}

/** Removes a plugin with every item it brought. Throws when it could not. */
export async function uninstallPlugin(
  scope: HostScope,
  plugin: InstalledKettuPlugin,
): Promise<void> {
  await scope.request('plugins.uninstall', { pluginId: plugin.id })
  const market = scope.useMarketplaceStore.getState()
  market.removePlugin(plugin.id)
  void market.loadCommunityInstalled(true)
  toast(
    t('toast.uninstalled', { name: pluginTitle(plugin.contents, currentLocale()) }),
    undefined,
    {
      tone: 'success',
    },
  )
}
