import remarkBreaks from 'remark-breaks'
import { defaultRemarkPlugins } from 'streamdown'
import { localImages } from './local-images'
import { localLinks } from './local-links'

// A line break in agent text is a line break, as in the agents' own terminals: a command's
// plain output, such as Claude Code's `/usage` when the adapter falls back to it, relies on it.
export const remarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  remarkBreaks,
  localLinks,
  localImages,
]
