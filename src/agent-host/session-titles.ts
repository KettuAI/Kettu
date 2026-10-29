// A title Kettu writes for a session whose agent writes none: its first message goes to a
// small model of its agent in a hidden session, removed afterwards as the reports' are.

import type { UserContent } from '@shared/thread'
import { repeatsFirstMessage } from './acp/mapper'
import { writeTitles } from './outline-titles'
import type { HiddenRuntime } from './reports'

/** The message keeps this much of its text for the title's prompt. */
export const TITLE_PROMPT_CHARS = 2_000

// OpenCode's title for a session no model has titled yet.
const UNTITLED = /^(New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export interface SessionTitleRequest {
  /** The empty folder hidden sessions run in. */
  dir: string
  /** The session's model, for an agent that offers no small one. */
  sessionModel: string | null
  message: readonly UserContent[]
  log(message: string): void
  timeoutMs?: number
}

/** The message's text parts, joined and cut for the prompt. */
export function titleMessageText(message: readonly UserContent[]): string {
  const text = message.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  return Array.from(text).slice(0, TITLE_PROMPT_CHARS).join('')
}

/**
 * Asks the agent for a title from the message in a hidden session of its own, then removes it.
 * Rejects when the agent cannot open one that leaves no trace, fails, takes longer than the
 * timeout or answers with no title.
 */
export async function writeSessionTitle(
  runtime: HiddenRuntime,
  request: SessionTitleRequest,
): Promise<string> {
  const titles = await writeTitles(runtime, {
    dir: request.dir,
    sessionModel: request.sessionModel,
    messages: [{ pos: 0, text: titleMessageText(request.message) }],
    cut: TITLE_PROMPT_CHARS,
    name: 'the session title',
    log: request.log,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  })
  const title = titles.find((entry) => entry.pos === 0)?.title
  if (!title) throw new Error('its reply held no title')
  return title
}

/**
 * A title an agent lists for the session, unless it is empty, says only that the session has no
 * title yet, or repeats the message the session started with.
 */
export function listedTitle(title: string | null, firstMessage: string | null): string | null {
  if (title === null) return null
  const value = title.trim()
  if (value === '' || UNTITLED.test(value)) return null
  if (repeatsFirstMessage(value, firstMessage)) return null
  return value
}
