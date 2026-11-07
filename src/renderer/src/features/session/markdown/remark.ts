import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import { defaultRemarkPlugins, type StreamdownProps } from 'streamdown'
import { githubRefs } from './github-refs'
import { localImages } from './local-images'
import { localLinks } from './local-links'

// A line break in agent text is a line break, as in the agents' own terminals: a command's
// plain output, such as Claude Code's `/usage` when the adapter falls back to it, relies on it.
// Maths takes `$$`, inline or on lines of its own; a single `$` stays text, since replies quote
// prices far more often than formulas.
export const remarkPlugins: NonNullable<StreamdownProps['remarkPlugins']> = [
  ...Object.values(defaultRemarkPlugins),
  [remarkMath, { singleDollarTextMath: false }],
  remarkBreaks,
  localLinks,
  localImages,
  githubRefs,
]
