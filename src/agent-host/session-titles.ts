// A title Kettu writes for a session whose agent writes none: its first message goes to a
// small model of its agent in a hidden session, removed afterwards as the reports' are. A new
// worktree's branch is named the same way.

import type { UserContent } from '@shared/thread'
import { writeTitles, type ModelPick } from './outline-titles'
import type { HiddenRuntime } from './reports'
import { repeatsFirstMessage, titleWithoutAhead } from './session-updates'

/** The message keeps this much of its text for the title's prompt. */
export const TITLE_PROMPT_CHARS = 2_000

// OpenCode's title for a session no model has titled yet.
const UNTITLED = /^(New|Child) session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const BRANCH_INSTRUCTION =
  'Name a Git branch for the work each message below asks for, in two to five English words ' +
  "whatever the message's language, such as fix-rss-feed-timezones. Answer with only a JSON " +
  'object that maps each id to its branch name.'

export interface SessionTitleRequest {
  /** The empty folder hidden sessions run in. */
  dir: string
  model: ModelPick
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
export function writeSessionTitle(
  runtime: HiddenRuntime,
  request: SessionTitleRequest,
): Promise<string> {
  return writeOne(runtime, request, { name: 'the session title', what: 'title' })
}

/**
 * Asks the agent, as for a title, for a few English words that name a branch for the work the
 * message asks for. The reply is untrusted: only a slug's characters of it may name anything.
 */
export function writeBranchSlug(
  runtime: HiddenRuntime,
  request: SessionTitleRequest,
): Promise<string> {
  return writeOne(runtime, request, {
    name: 'the branch name',
    what: 'branch name',
    instruction: BRANCH_INSTRUCTION,
  })
}

async function writeOne(
  runtime: HiddenRuntime,
  request: SessionTitleRequest,
  { name, what, instruction }: { name: string; what: string; instruction?: string },
): Promise<string> {
  const titles = await writeTitles(runtime, {
    dir: request.dir,
    model: request.model,
    messages: [{ pos: 0, text: titleMessageText(request.message) }],
    cut: TITLE_PROMPT_CHARS,
    name,
    ...(instruction === undefined ? {} : { instruction }),
    log: request.log,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  })
  const title = titles.find((entry) => entry.pos === 0)?.title
  if (!title) throw new Error(`its reply held no ${what}`)
  return title
}

/**
 * A title an agent lists for the session, unless it is empty, says only that the session has no
 * title yet, or repeats the message the session started with.
 */
export function listedTitle(title: string | null, firstMessage: string | null): string | null {
  if (title === null) return null
  const value = titleWithoutAhead(title).trim()
  if (value === '' || UNTITLED.test(value)) return null
  if (repeatsFirstMessage(value, firstMessage)) return null
  return value
}
