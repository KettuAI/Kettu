import type { McpInstallEntry } from '@shared/mcp-discovery'
import type { MarketKeys } from './market-keys'
import { mergeSettings, validateSettingsPatch } from './settings-schema'
import type { SettingsStore } from './settings'

export async function installDiscoveredMcp(
  settings: SettingsStore,
  keys: MarketKeys,
  entries: McpInstallEntry[],
): Promise<string | null> {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 100) {
    return 'Choose between 1 and 100 MCP servers to install.'
  }
  try {
    const candidates = entries.map(({ server }) => server)
    const ids = new Set(candidates.map(({ id }) => id))
    const ensureNew = (): void => {
      if (
        ids.size !== candidates.length ||
        candidates.some(({ source }) => source !== 'manual') ||
        settings.get().marketplace.mcp.some(({ id }) => ids.has(id))
      ) {
        throw new Error('The imported servers need unique ids.')
      }
    }
    const patch = validateSettingsPatch({ marketplace: { mcpEdit: { put: candidates } } })
    ensureNew()
    mergeSettings(settings.get(), patch)
    await keys.install(entries, () => {
      ensureNew()
      settings.update(patch)
    })
    return null
  } catch {
    return 'Could not save the MCP servers and their keys.'
  }
}
