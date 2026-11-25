// The themes the plugins that are on bring. The agent host lists their files in one index in the
// data folder, and whoever keeps the themes, main or the daemon, reads the files like any other
// theme file, so nothing of a plugin's theme is trusted before it passes the same checks.

import { PLUGIN_ID, type PluginResource } from './plugins'
import { themeSlug } from './themes'

export const PLUGIN_THEMES_FILE = 'plugin-themes.json'
export const PLUGIN_THEMES_VERSION = 1

// Leaves room for the plugin's id and the dashes before it in a theme id of 64 characters.
const MAX_SLUG = 46

/** One theme of a plugin that is on, by the id it shows under in the themes. */
export interface PluginThemeEntry {
  id: string
  pluginId: string
  /** The plugin's title. */
  plugin: string
  /** The theme's file on the host. */
  file: string
}

/**
 * The entries for the themes of the plugins that are on. An id is the plugin's id, two dashes
 * and the theme's name, which a theme installed from a file never has, since its id never holds
 * two dashes in a row.
 */
export function pluginThemeEntries(resources: readonly PluginResource[]): PluginThemeEntry[] {
  const taken = new Set<string>()
  return resources.map((item) => {
    const slug = themeSlug(item.name).slice(0, MAX_SLUG).replace(/-+$/, '') || 'theme'
    let id = `${item.pluginId}--${slug}`
    for (let n = 2; taken.has(id); n++) {
      const suffix = `-${n}`
      id = `${item.pluginId}--${slug.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, '')}${suffix}`
    }
    taken.add(id)
    return { id, pluginId: item.pluginId, plugin: item.plugin, file: item.file }
  })
}

/** The plugin a theme's id says brought it; null for a theme installed from a file. */
export function pluginOfTheme(themeId: string): string | null {
  const at = themeId.indexOf('--')
  const pluginId = at < 0 ? '' : themeId.slice(0, at)
  return PLUGIN_ID.test(pluginId) ? pluginId : null
}
