// Turning a Claude Code or Codex plugin into a Kettu plugin: what came over, what was left out and
// why. The conversion writes a new folder and never changes the one it read.

import type { PublishAdds } from './market-publish'

/** The harnesses whose plugins convert. */
export type ConvertFrom = 'claude-code' | 'codex'

/** A sentence in English, which agents and logs read, and in the user's language when that differs. */
export interface ConvertText {
  message: string
  text?: string
}

/** A part of the plugin that did not come over. */
export interface ConvertLeftOut extends ConvertText {
  kind: 'hook' | 'command' | 'agent' | 'server' | 'skill' | 'file'
  /** What it is called: a hook's event and matcher, an item's name, or a path. */
  name: string
}

/** Something that came over but changed, or lost a part of itself. */
export interface ConvertNote extends ConvertText {
  name: string
}

export interface PluginConversion {
  from: ConvertFrom
  /** What came over, as an install adds it: `skills`, `servers`, `commands` and `roles`. */
  carried: PublishAdds[]
  leftOut: ConvertLeftOut[]
  notes: ConvertNote[]
}

/** A converted package, written to a folder of its own. */
export interface PluginConverted {
  /** The new folder, absolute. */
  path: string
  /** The Kettu plugin's name. */
  name: string
  conversion: PluginConversion
}
