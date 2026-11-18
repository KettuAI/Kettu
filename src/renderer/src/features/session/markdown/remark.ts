import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import { defaultRemarkPlugins, type StreamdownProps } from 'streamdown'
import { codexCitations } from './codex-citations'
import { emojiShortcodes } from './emoji-shortcodes'
import { githubRefs } from './github-refs'
import { gluedLinks } from './glued-links'
import { localImages } from './local-images'
import { localLinks } from './local-links'

type RemarkPlugins = NonNullable<StreamdownProps['remarkPlugins']>

// Only `~~text~~` strikes text through: a lone `~` is far more often a home path, and two of
// them would strike out everything in between.
const defaults = Object.entries(defaultRemarkPlugins).map(
  ([name, plugin]): RemarkPlugins[number] =>
    name === 'gfm' && Array.isArray(plugin) ? [plugin[0], { singleTilde: false }] : plugin,
)

// A line break in agent text is a line break, as in the agents' own terminals: a command's
// plain output, such as Claude Code's `/usage` when the adapter falls back to it, relies on it.
// Maths takes `$$`, inline or on lines of its own; a single `$` stays text, since replies quote
// prices far more often than formulas.
export const remarkPlugins: RemarkPlugins = [
  ...defaults,
  gluedLinks,
  [remarkMath, { singleDollarTextMath: false }],
  remarkBreaks,
  emojiShortcodes,
  codexCitations,
  localLinks,
  localImages,
  githubRefs,
]
