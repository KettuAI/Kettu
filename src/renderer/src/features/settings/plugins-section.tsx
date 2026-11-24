import { useEffect } from 'react'
import { PuzzleIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { pluginTitle } from '@renderer/features/marketplace/plugin-model'
import {
  useInstalledPlugins,
  usePluginPublisher,
} from '@renderer/features/marketplace/plugin-hooks'
import { currentLocale } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import { openSettingsItem, openSettingsRow } from '@renderer/stores/view'
import { PluginPage, PluginRow } from './plugin-page'
import type { GroupDef, RowDef, SectionDef } from './model'
import { EmptyRow, Notice } from './rows'
import { SetButton, Spin } from './controls'

const LIST: GroupDef = { id: 'plugins', label: '', unlabeled: true }

/** Settings › Plugins: the installed plugins, each opening a page of its own with its settings. */
export function usePluginsSection(): SectionDef {
  const { t } = useTranslation('settings')
  const { useMarketplaceStore } = useHostScope()
  const plugins = useInstalledPlugins()
  const error = useMarketplaceStore((s) => s.pluginsError)
  const load = useMarketplaceStore((s) => s.loadPlugins)
  const publisher = usePluginPublisher()
  useEffect(() => {
    if (plugins === null) void load()
  }, [plugins, load])
  const locale = currentLocale()

  const base = {
    id: 'plugins' as const,
    title: t('sections.plugins'),
    description: t('pages.plugins'),
    icon: PuzzleIcon,
    itemPage: (item: string) => <PluginPage id={item} />,
  }
  if (plugins === null) {
    return {
      ...base,
      rows: [],
      footer:
        error === null ? (
          <Spin label={t('plugins.loading')} />
        ) : (
          <Notice
            variant="error"
            title={t('plugins.readFailed', { error })}
            action={<SetButton onClick={() => void load()}>{t('plugins.retry')}</SetButton>}
          />
        ),
    }
  }
  if (plugins.length === 0) {
    return {
      ...base,
      rows: [
        {
          id: 'none',
          setting: 'plugins.text',
          item: { name: t('plugins.empty.title'), description: t('plugins.empty.hint') },
          group: LIST,
          layout: 'custom',
          render: () => (
            <EmptyRow title={t('plugins.empty.title')} hint={t('plugins.empty.hint')} />
          ),
        },
      ],
    }
  }
  const rows: RowDef[] = plugins.flatMap((plugin) => {
    const title = pluginTitle(plugin.contents, locale)
    const row: RowDef = {
      id: `plugin:${plugin.id}`,
      setting: 'plugins.text',
      item: {
        name: title,
        description: [publisher(plugin), plugin.contents.description].filter(Boolean).join(' · '),
      },
      group: LIST,
      layout: 'custom',
      open: () => openSettingsItem('plugins', plugin.id),
      render: () => <PluginRow plugin={plugin} title={title} publisher={publisher(plugin)} />,
    }
    // Each setting is found by search, which opens the plugin's page at it.
    const settings = plugin.contents.settings.map((setting): RowDef => ({
      id: `plugin:${plugin.id}:${setting.key}`,
      setting: 'plugins.text',
      item: {
        name: setting.title,
        description: [title, setting.description].filter(Boolean).join(' · '),
      },
      searchOnly: true,
      open: () => openSettingsRow('plugins', plugin.id, `setting-${setting.key}`),
      render: () => null,
    }))
    return [row, ...settings]
  })
  return { ...base, rows }
}
