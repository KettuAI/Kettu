import { useEffect } from 'react'
import { dropGonePluginPanes } from '@renderer/stores/plugin-panes'
import { usePluginSurfaces } from '@renderer/stores/plugin-surfaces'
import { pluginPaneId } from '@renderer/stores/view'

/**
 * Takes off a panel's plugin tabs that a restart brought back for a pane the host no longer has,
 * once the host has said which plugins are on.
 */
export function useGonePluginPanes(panel: string, hostId: string | null): void {
  const { plugins, loaded } = usePluginSurfaces(hostId)
  useEffect(() => {
    if (!loaded) return
    const present = new Set(
      plugins.flatMap((plugin) =>
        plugin.panes.map((pane) => pluginPaneId(plugin.pluginId, pane.id)),
      ),
    )
    dropGonePluginPanes(panel, present)
  }, [panel, plugins, loaded])
}
