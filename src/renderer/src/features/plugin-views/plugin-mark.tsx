import type { PluginRefSource } from '@shared/plugin-refs'
import { PluginTile } from './plugin-tile'

/**
 * A plugin's tile at the size of a line of text, drawn as its tile everywhere else. It leads the
 * plugin's group in the `@` menu and the plugin's references in replies.
 */
export function PluginMark({ source }: { source: Pick<PluginRefSource, 'name' | 'icon'> }) {
  return <PluginTile name={source.name} icon={source.icon} size={16} />
}
