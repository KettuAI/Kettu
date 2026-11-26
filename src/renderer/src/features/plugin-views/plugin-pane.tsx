// A plugin's pane as a tab of the side panel: one of its views, on the host the session runs on.
// A plugin that is off, gone or crashed shows that view's own error state, never a broken panel,
// and one whose required settings are empty shows how to set it up.

import { useMemo, type ReactNode } from 'react'
import { Settings02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { missingWords } from '@renderer/features/marketplace/plugin-model'
import { openPluginPage } from '@renderer/features/marketplace/plugin-landing'
import { Glyph } from '@renderer/features/shell/glyph'
import { PaneBody } from '@renderer/features/shell/panel-button'
import { hostAt, type HostRequest } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { usePluginSurfaces, type PluginSurface } from '@renderer/stores/plugin-surfaces'
import { panelSession, shownDoc, useViewStore, type SessionView } from '@renderer/stores/view'
import { languageText, surfaceTitle } from './plugin-text'
import { PluginTile } from './plugin-tile'
import { PluginView } from './plugin-view'

export default function PluginPane({ panel, projectPath }: { panel: string; projectPath: string }) {
  const tab = useViewStore((s) => shownDoc(s, panel))
  const hostId = hostOfPath(projectPath)
  const request = useMemo<HostRequest>(
    () => (method, params) => hostAt(hostId, method, params),
    [hostId],
  )
  const surfaces = usePluginSurfaces(hostId)
  if (tab?.kind !== 'plugin') return null
  const surface = surfaces.plugins.find((plugin) => plugin.pluginId === tab.pluginId)
  // The plugin's page, whose Back returns to this session once it has one.
  const sessionId = panelSession(panel)
  const from: SessionView | undefined = sessionId
    ? { kind: 'session', sessionId, projectPath }
    : undefined
  const settings = <PluginSettingsButton pluginId={tab.pluginId} hostId={hostId} from={from} />
  if (surface && surface.missing.length > 0) {
    return (
      <PaneBody>
        <SetUp surface={surface} viewId={tab.viewId} hostId={hostId} from={from} tools={settings} />
      </PaneBody>
    )
  }
  return (
    <PaneBody>
      <PluginView
        // The view starts over when its plugin is updated, turned off or on.
        key={surface?.revision ?? 'off'}
        request={request}
        pluginId={tab.pluginId}
        viewId={tab.viewId}
        params={tab.params}
        tools={settings}
      />
    </PaneBody>
  )
}

/** The bar's last tool: the plugin's page. */
function PluginSettingsButton({
  pluginId,
  hostId,
  from,
}: {
  pluginId: string
  hostId: string | null
  from?: SessionView
}) {
  const { t } = useTranslation('plugin-views')
  return (
    <Button
      variant="quiet"
      size="icon-sm"
      aria-label={t('pluginSettings')}
      title={t('pluginSettings')}
      onClick={() => openPluginPage(pluginId, { from, hostId })}
    >
      <Glyph icon={Settings02Icon} size={15} />
    </Button>
  )
}

/** The pane while a required setting is empty: what it would show, and the way to set it up. */
function SetUp({
  surface,
  viewId,
  hostId,
  from,
  tools,
}: {
  surface: PluginSurface
  viewId: string
  hostId: string | null
  from?: SessionView
  tools: ReactNode
}) {
  const { t, i18n } = useTranslation('plugin-views')
  const plugin = surfaceTitle(surface, i18n.language)
  const pane = surface.panes.find((view) => view.id === viewId)
  const view = (pane && languageText(pane.title, i18n.language)) || viewId
  return (
    <div className="kpv">
      <div className="kpv-bar">
        <PluginTile name={surface.name} icon={surface.icon} size={14} />
        <div className="kpv-scope">
          <span>{plugin}</span>
        </div>
        {tools}
      </div>
      <div className="kpv-scroll">
        <Empty className="kpv-state">
          <EmptyHeader>
            <EmptyMedia>
              <PluginTile name={surface.name} icon={surface.icon} size={56} />
            </EmptyMedia>
            <EmptyTitle>{t('setup.title', { plugin, view })}</EmptyTitle>
            <EmptyDescription>
              {t('setup.text', { plugin, missing: missingWords(surface.missing) })}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              size="sm"
              onClick={() => openPluginPage(surface.pluginId, { setup: true, from, hostId })}
            >
              {t('setup.action', { plugin })}
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    </div>
  )
}
