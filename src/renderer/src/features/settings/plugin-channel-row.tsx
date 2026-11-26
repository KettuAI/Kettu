// One channel a plugin adds, as Settings › Notifications lists it: the plugin's tile, the channel
// and which notices it gets, opening the plugin's page.

import { useTranslation } from 'react-i18next'
import { pluginState, type InstalledKettuPlugin } from '@shared/plugins'
import { pluginTitle } from '@renderer/features/marketplace/plugin-model'
import { openPluginPage } from '@renderer/features/marketplace/plugin-landing'
import { PluginStateMark } from '@renderer/features/marketplace/plugin-state'
import { PluginTile } from '@renderer/features/plugin-views/plugin-tile'
import { currentLocale } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import { ItemLine, ItemRow } from './rows'

export function PluginChannelRow({
  plugin,
  title,
  kinds,
}: {
  plugin: InstalledKettuPlugin
  title: string
  kinds: string
}) {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  const name = pluginTitle(plugin.contents, currentLocale())
  const state = pluginState(plugin)
  return (
    <ItemRow
      item={`channel-${plugin.id}`}
      label={t('notifications.alsoSent.open', { channel: title, plugin: name })}
      tile={<PluginTile name={plugin.contents.name} icon={plugin.contents.icon} size={24} />}
      name={title}
      onOpen={() => openPluginPage(plugin.id, { hostId })}
    >
      <ItemLine>
        {state === 'ready' ? kinds : <PluginStateMark plugin={plugin} long />}
        {' · '}
        {name}
      </ItemLine>
    </ItemRow>
  )
}
