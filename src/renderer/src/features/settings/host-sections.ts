import { useSettingsHostStore } from '@renderer/stores/host-scope'
import {
  openSettings,
  openSettingsItem,
  useViewStore,
  type SettingsSection,
} from '@renderer/stores/view'
import { windowHost } from '@renderer/stores/window-host'

/** The sections that belong to a host, which the host picker switches. */
export const HOST_SECTIONS: ReadonlySet<SettingsSection> = new Set([
  'agents',
  'harnesses',
  'memory',
  'usage',
  'git',
  'archived',
  'artifacts',
  'sharing',
  'terminal',
  'remote',
  'advanced',
])

let picked = false

// Opened, Settings starts at the window's host, unless the way into it named a host.
useViewStore.subscribe((state, previous) => {
  if (!state.settings.open || previous.settings.open) return
  const named = picked
  picked = false
  if (named) return
  const host = windowHost()
  useSettingsHostStore.setState({ hostId: host.kind === 'one' ? host.hostId : null })
})

/** Opens the host's sections in Settings: the one shown if it is the host's, else Agents. */
export function openHostSettings(hostId: string | null): void {
  if (!useViewStore.getState().settings.open) picked = true
  useSettingsHostStore.setState({ hostId })
  const { section } = useViewStore.getState().settings
  openSettings(section && HOST_SECTIONS.has(section) ? section : 'agents')
}

/** Opens one of the host's sections at an item's own page, as a link from its thread does. */
export function openHostSettingsItem(
  hostId: string | null,
  section: SettingsSection,
  item: string | null,
): void {
  if (!useViewStore.getState().settings.open) picked = true
  useSettingsHostStore.setState({ hostId })
  openSettingsItem(section, item)
}
