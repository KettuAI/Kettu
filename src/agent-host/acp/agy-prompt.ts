// agy's `_meta.antigravity.systemPrompt.append` on `session/new`: text added to the new session's
// system prompt. agy keeps it with the session, out of the user's messages and the replay, and
// still has it after `/compact` and after its process starts again and resumes the session, so
// load and resume pass nothing (1.5.9 measured).

import { compareVersions } from '../versions'

export const SYSTEM_PROMPT_VERSION = '1.5.9'

/** Whether agy takes the addition: a version it was measured on, which declares it. */
export function takesSystemPromptAppend(version: string | null, capabilities: unknown): boolean {
  if (version === null || compareVersions(version, SYSTEM_PROMPT_VERSION) < 0) return false
  const meta = (
    capabilities as { _meta?: { antigravity?: { systemPrompt?: { append?: unknown } } } }
  )?._meta
  return meta?.antigravity?.systemPrompt?.append === true
}

/** The `_meta` of a `session/new` that adds `text` to the session's system prompt. */
export function systemPromptMeta(text: string): Record<string, unknown> {
  return { antigravity: { systemPrompt: { append: text } } }
}
