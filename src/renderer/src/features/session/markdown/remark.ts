import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import type { StreamdownProps } from 'streamdown'
import { cjkPlugin, defaultRemarkPluginsNoSingleTilde } from './cjk-plugin'
import { codexCitations } from './codex-citations'
import { emojiShortcodes } from './emoji-shortcodes'
import { githubRefs } from './github-refs'
import { gluedLinks } from './glued-links'
import { localImages } from './local-images'
import { localLinks } from './local-links'
import { replyMath } from './maths'

type RemarkPlugins = NonNullable<StreamdownProps['remarkPlugins']>

export { cjkPlugin }

// A line break in agent text is a line break, as in the agents' own terminals: a command's
// plain output, such as Claude Code's `/usage` when the adapter falls back to it, relies on it.
// Maths takes `$$`, inline or on lines of its own; a single `$` is replyMath's, which keeps prices
// as text, and so are `\(...\)` and `\[...\]`.
export const remarkPlugins: RemarkPlugins = [
  ...defaultRemarkPluginsNoSingleTilde,
  gluedLinks,
  [remarkMath, { singleDollarTextMath: false }],
  replyMath,
  remarkBreaks,
  emojiShortcodes,
  codexCitations,
  localLinks,
  localImages,
  githubRefs,
]
