// agy's /compact as the compaction divider every agent gets. agy 1.5.9 compacts without saying
// so over ACP: the turn that sent the command ends with a usage_update and `end_turn`, and no
// compaction update comes in between.

import type { PromptBlock } from '../connection'
import { compareVersions } from '../versions'

export const AGY_COMPACT_VERSION = '1.5.9'

export function compactsAgy(version: string | null): boolean {
  return version !== null && compareVersions(version, AGY_COMPACT_VERSION) >= 0
}

/** Whether a prompt opens with agy's /compact, alone or followed by summarization instructions. */
export function sentCompact(prompt: readonly PromptBlock[]): boolean {
  const first = prompt[0]
  return first?.type === 'text' && /^\/compact(?:\s|$)/.test(first.text)
}
