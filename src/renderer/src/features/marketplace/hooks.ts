import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { InstalledPlugin, PluginHarness } from '@shared/marketplace'
import { menuAgents, useAgentsStore } from '@renderer/stores/agents'
import { busyKey, useMarketplaceStore } from '@renderer/stores/marketplace'
import { useProjectsStore } from '@renderer/stores/projects'
import { count } from '@renderer/lib/format'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useSettingsStore } from '@renderer/stores/settings'
import { pluginInstalls } from './model'

/** The agents a server or skill can be given: those the agent menu lists. */
export function useChoosableAgents() {
  return useAgentsStore(useShallow((s) => menuAgents(s.order, s.byId)))
}

/** The agents of a harness that installs plugins itself. */
export function useHarnessAgents(harness: PluginHarness) {
  return useAgentsStore(
    useShallow((s) => menuAgents(s.order, s.byId).filter((a) => a.harnessId === harness)),
  )
}

/** Whether Kettu keeps the server with this id. */
export function useKept(id: string): boolean {
  return useSettingsStore((s) => s.settings.marketplace.mcp.some((server) => server.id === id))
}

/** Whether Kettu keeps the skill with this id. */
export function useKeptSkill(id: string): boolean {
  return useSettingsStore((s) => s.settings.marketplace.skills.some((skill) => skill.id === id))
}

export function useInstalling(id: string): boolean {
  return useBusy(busyKey('mcp', id))
}

export function useBusy(key: string): boolean {
  return useMarketplaceStore((s) => s.busy.includes(key))
}

/** The agents' installs of a plugin, as the host last listed them. */
export function usePluginInstalls(harness: PluginHarness, id: string): InstalledPlugin[] {
  return useMarketplaceStore(useShallow((s) => pluginInstalls(s.plugins?.installed, harness, id)))
}

/** This computer's projects, for a plugin installed into one project. */
export function useLocalProjects() {
  return useProjectsStore(
    useShallow((s) => s.projects.filter((p) => !p.missing && hostOfPath(p.path) === null)),
  )
}

/** "12.3K installs" as the marketplace counts them. */
export function useInstallsLabel(): (installs: number | null) => string | null {
  const { t } = useTranslation('marketplace')
  return (installs) =>
    installs === null ? null : t('plugin.installs', { count: installs, value: count(installs) })
}
