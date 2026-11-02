import { useSettingsHostStore } from '@renderer/stores/host-scope'
import { openSettings, useViewStore, type SettingsSection } from '@renderer/stores/view'

/** The sections that belong to a host, which the host picker switches. */
export const HOST_SECTIONS: ReadonlySet<SettingsSection> = new Set([
  'agents',
  'harnesses',
  'usage',
  'git',
  'mcp',
  'archived',
  'sharing',
  'terminal',
  'remote',
  'advanced',
])

/** Opens the host's sections in Settings: the one shown if it is the host's, else Agents. */
export function openHostSettings(hostId: string | null): void {
  useSettingsHostStore.setState({ hostId })
  const { section } = useViewStore.getState().settings
  openSettings(section && HOST_SECTIONS.has(section) ? section : 'agents')
}
