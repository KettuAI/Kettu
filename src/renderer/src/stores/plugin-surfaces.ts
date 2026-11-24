import { useEffect } from 'react'
import { create } from 'zustand'
import type { PluginActionDecl, PluginViewDecl } from '@shared/plugin-views'
import type { InstalledKettuPlugin, PluginTexts } from '@shared/plugins'
import { hostAt } from '@renderer/lib/host'

/** What a plugin that is on shows outside its own page: panes for the side panel, actions for Search. */
export interface PluginSurface {
  pluginId: string
  /** The package's name, which a tile is picked by when the package has no icon. */
  name: string
  title: string
  titles: PluginTexts
  /** The package's icon as a data URL. */
  icon: string | null
  /** Changes when the plugin is updated, turned off or on, so what it drew starts over. */
  revision: string
  panes: PluginViewDecl[]
  actions: PluginActionDecl[]
}

interface HostSurfaces {
  /** The plugins of the host that give a pane or an action. */
  plugins: PluginSurface[]
  /** Whether the host has answered once; false for a host not read yet, or one that failed. */
  loaded: boolean
}

interface PluginSurfacesStore {
  /** By host id, '' for this computer. */
  byHost: Record<string, HostSurfaces>
}

const NOT_READ: HostSurfaces = { plugins: [], loaded: false }

export const usePluginSurfacesStore = create<PluginSurfacesStore>()(() => ({ byHost: {} }))

const keyOf = (hostId: string | null): string => hostId ?? ''

/** The plugins of a host that are on and have panes or Search actions. */
export function surfacesOf(plugins: readonly InstalledKettuPlugin[]): PluginSurface[] {
  return plugins.flatMap((plugin): PluginSurface[] => {
    const { contents } = plugin
    if (!plugin.enabled || !contents.script) return []
    const panes = contents.views.filter((view) => view.pane)
    const actions = contents.actions ?? []
    if (panes.length === 0 && actions.length === 0) return []
    return [
      {
        pluginId: plugin.id,
        name: contents.name,
        title: contents.title,
        titles: contents.titles,
        icon: contents.icon,
        revision: `${plugin.updatedAt}`,
        panes,
        actions,
      },
    ]
  })
}

const reading = new Map<string, Promise<void>>()

/**
 * Reads a host's plugins again. A host that does not answer keeps what it had, and one never read
 * stays unread, so what is gone is not told from what could not be reached.
 */
export function loadPluginSurfaces(hostId: string | null): Promise<void> {
  const key = keyOf(hostId)
  const running = reading.get(key)
  if (running) return running
  const read = hostAt(hostId, 'plugins.list', undefined)
    .then(
      ({ plugins }) => {
        usePluginSurfacesStore.setState((s) => ({
          byHost: { ...s.byHost, [key]: { plugins: surfacesOf(plugins), loaded: true } },
        }))
      },
      () => undefined,
    )
    .finally(() => reading.delete(key))
  reading.set(key, read)
  return read
}

/** The host said a plugin changed: a host read before is read again. */
export function pluginSurfacesChanged(hostId: string | null): void {
  if (usePluginSurfacesStore.getState().byHost[keyOf(hostId)]?.loaded) {
    void loadPluginSurfaces(hostId)
  }
}

/**
 * The host's plugins with panes or Search actions, read when first asked for and kept current by
 * the host's own word; `loaded` tells a host not read yet from one without any.
 */
export function usePluginSurfaces(hostId: string | null): HostSurfaces {
  const surfaces = usePluginSurfacesStore((s) => s.byHost[keyOf(hostId)])
  const read = !!surfaces
  useEffect(() => {
    if (!read) void loadPluginSurfaces(hostId)
  }, [hostId, read])
  return surfaces ?? NOT_READ
}
