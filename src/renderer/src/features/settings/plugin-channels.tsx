// Settings › Notifications' Also sent to: the channels plugins add, each saying which notices it
// gets and opening its plugin's page, the only place those are chosen.

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { InstalledKettuPlugin } from '@shared/plugins'
import { useInstalledPlugins } from '@renderer/features/marketplace/plugin-hooks'
import { openPluginPage } from '@renderer/features/marketplace/plugin-landing'
import { channelText } from '@renderer/features/marketplace/plugin-model'
import { currentLocale } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import type { GroupDef, RowDef } from './model'
import { PluginChannelRow } from './plugin-channel-row'

type Channel = NonNullable<InstalledKettuPlugin['contents']['channels']>[number]

/** The rows of Also sent to, one per channel of a plugin on the host; none when no plugin adds one. */
export function usePluginChannelRows(): RowDef[] {
  const { t } = useTranslation('settings')
  const { hostId, useMarketplaceStore } = useHostScope()
  const plugins = useInstalledPlugins()
  const load = useMarketplaceStore((s) => s.loadPlugins)
  useEffect(() => {
    if (plugins === null) void load()
  }, [plugins, load])
  const kindNames = useKindNames()
  const group: GroupDef = {
    id: 'also-sent',
    label: t('notifications.groups.alsoSent'),
    description: t('notifications.alsoSent.description'),
  }
  return (plugins ?? []).flatMap((plugin) =>
    (plugin.contents.channels ?? []).map((channel): RowDef => {
      const { title } = channelText(channel)
      const kinds = kindNames(plugin, channel)
      return {
        id: `channel-${plugin.id}-${channel.id}`,
        setting: 'notifications.plugin-channels',
        item: { name: title, description: kinds },
        group,
        layout: 'custom',
        open: () => openPluginPage(plugin.id, { hostId }),
        render: () => <PluginChannelRow plugin={plugin} title={title} kinds={kinds} />,
      }
    }),
  )
}

/** Which notices a channel gets, as one line: "Needs approval and Errors", or that it gets none. */
function useKindNames(): (plugin: InstalledKettuPlugin, channel: Channel) => string {
  const { t } = useTranslation('settings')
  const locale = currentLocale()
  return (plugin, channel) => {
    const picked = plugin.channelKinds?.[channel.id] ?? []
    if (picked.length === 0) return t('notifications.alsoSent.none')
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(
      picked.map((kind) => t(`notifications.${kind}.name`)),
    )
  }
}
