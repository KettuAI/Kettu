// A plugin's pane as a tab of the side panel: one of its views, on the host the session runs on.
// A plugin that is off, gone or crashed shows that view's own error state, never a broken panel.

import { useMemo } from 'react'
import { hostAt, type HostRequest } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { usePluginSurfaces } from '@renderer/stores/plugin-surfaces'
import { shownDoc, useViewStore } from '@renderer/stores/view'
import { PaneBody } from '@renderer/features/shell/panel-button'
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
  return (
    <PaneBody>
      <PluginView
        // The view starts over when its plugin is updated, turned off or on.
        key={surface?.revision ?? 'off'}
        request={request}
        pluginId={tab.pluginId}
        viewId={tab.viewId}
        params={tab.params}
      />
    </PaneBody>
  )
}
