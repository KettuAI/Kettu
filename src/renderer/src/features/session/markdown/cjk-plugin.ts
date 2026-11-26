import { cjk, type CjkPlugin } from '@streamdown/cjk'
import { defaultRemarkPlugins, type StreamdownProps } from 'streamdown'

type RemarkPlugins = NonNullable<StreamdownProps['remarkPlugins']>
type Pluggable = CjkPlugin['remarkPluginsAfter'][number]

const STRIKETHROUGH_OPTIONS = { singleTilde: false } as const

function isStrikethroughPlugin(plugin: unknown): boolean {
  return typeof plugin === 'function' && /strikethrough/i.test(plugin.name)
}

function withSingleTildeDisabled(plugin: Pluggable): Pluggable {
  if (isStrikethroughPlugin(plugin)) {
    return [plugin, STRIKETHROUGH_OPTIONS] as unknown as Pluggable
  }
  if (Array.isArray(plugin) && isStrikethroughPlugin(plugin[0])) {
    const existing = plugin[1]
    const options =
      existing && typeof existing === 'object'
        ? { ...existing, ...STRIKETHROUGH_OPTIONS }
        : STRIKETHROUGH_OPTIONS
    return [plugin[0], options, ...plugin.slice(2)] as unknown as Pluggable
  }
  return plugin
}

/**
 * `@streamdown/cjk` appends `remark-cjk-friendly-gfm-strikethrough` without options, which
 * defaults back to `singleTilde: true` and overrides `remarkGfm`'s `{ singleTilde: false }`.
 * Wrap it so single `~...~` (e.g. home paths and shell prompts) never strikes through, while
 * keeping CJK emphasis, CJK autolink splitting, and `~~...~~` CJK strikethrough intact.
 */
export function createSingleTildeSafeCjkPlugin(base: CjkPlugin = cjk): CjkPlugin {
  const remarkPluginsAfter = base.remarkPluginsAfter.map(withSingleTildeDisabled)
  return {
    ...base,
    remarkPluginsAfter,
    remarkPlugins: [...base.remarkPluginsBefore, ...remarkPluginsAfter],
  }
}

export const cjkPlugin: CjkPlugin = createSingleTildeSafeCjkPlugin()

/**
 * Streamdown's default remark plugins with GFM single-tilde strikethrough disabled: only `~~text~~`
 * strikes text through, so home paths (`~/a`, `~/b`) and shell prompts (`~#`) stay intact.
 */
export const defaultRemarkPluginsNoSingleTilde: RemarkPlugins = Object.entries(
  defaultRemarkPlugins,
).map(([name, plugin]): RemarkPlugins[number] =>
  name === 'gfm' && Array.isArray(plugin) ? [plugin[0], STRIKETHROUGH_OPTIONS] : plugin,
)
