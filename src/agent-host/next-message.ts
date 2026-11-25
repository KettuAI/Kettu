// The next-message suggestion for agents without one of their own: which way each agent gives one,
// the question a fork of the session is asked, and the tool an agent that cannot fork calls once
// its reply is written. The host shows a turn's suggestion only once the turn ends normally.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { harnessOf } from '@shared/agents'
import type { AgentId, ConfigOption } from '@shared/thread'
import { removesHiddenSessions } from './acp/hidden-sessions'
import type { Caller } from './artifacts/tools'
import { SERVICE_NAME } from './service-name'

export const SUGGEST_TOOL = 'suggest_next_message'
/** A suggestion's characters at most: the composer shows one line of it. */
export const SUGGESTION_CHARS = 300
/** How long a fork may take to suggest before it is given up. */
export const SUGGEST_TIMEOUT_MS = 60_000

/**
 * How an agent suggests: Claude Code's own prompt suggestions, Codex's ephemeral fork, a fork the
 * agent makes and Kettu removes, or the tool; null when it gives none.
 */
export type SuggestionRoute = 'claude' | 'codex' | 'fork' | 'tool'

/**
 * The way the agent suggests, from what it can do: `allowsKettuTools`, its connection runs the
 * tools Kettu allows at start without asking, since a tool that asked would put a permission card
 * on every turn.
 */
export function suggestionRoute(
  agentId: AgentId,
  capabilities: { forkSession: boolean } | null,
  allowsKettuTools: boolean,
): SuggestionRoute | null {
  const harness = harnessOf(agentId)
  if (harness === 'claude-code') return 'claude'
  if (harness === 'codex') return 'codex'
  if (removesHiddenSessions(harness) && capabilities?.forkSession) return 'fork'
  return allowsKettuTools ? 'tool' : null
}

/** Whether the session is in plan mode, where no suggestion is given, as Claude Code gives none. */
export function planModeOn(config: readonly ConfigOption[]): boolean {
  return config.some((option) => option.category === 'mode' && option.value === 'plan')
}

/** What a fork of the session is asked, as a side question. */
export const SUGGEST_QUESTION =
  'Write the message the user is most likely to send next in this session, exactly as they ' +
  'would type it to you: one short line in the language they write in, with no quotes, label or ' +
  'explanation. Use no tool. If nothing likely comes next, answer NONE.'

/**
 * The sentence the agents that suggest by the tool get after the paragraph on Kettu's tools. Asked
 * for after the reply, agy 1.5.16 wrote its whole reply again once the call returned.
 */
export const SUGGEST_PROMPT =
  `In every turn, call \`${SUGGEST_TOOL}\` of the \`${SERVICE_NAME}\` MCP server right before ` +
  'your final reply, with the message the user is most likely to send after reading it, in ' +
  "the user's language."

export const SUGGEST_TOOLS: Tool[] = [
  {
    name: SUGGEST_TOOL,
    title: 'Suggest next message',
    description:
      "Shows the user's likely next message in the empty composer once the turn ends. Call it in " +
      'every turn, right before your final reply. Subagents must not call it.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          minLength: 1,
          maxLength: SUGGESTION_CHARS,
          description: "One short line in the user's language, as they would type it.",
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

export function isSuggestToolName(name: string): boolean {
  return name === SUGGEST_TOOL
}

/**
 * A suggestion as the composer shows it, from what an agent answered: the first line that says
 * something, without quotes or a label; null for none.
 */
export function suggestionText(answer: string): string | null {
  const line = answer
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text !== '' && !/^```/.test(text))
  if (line === undefined) return null
  let text = line
    .replace(/^>\s*/, '')
    .replace(/^(?:user|next message|suggestion)\s*[:：]\s*/i, '')
    .trim()
  const quoted = /^(["'`“‘「『])(.*)(["'`”’」』])$/u.exec(text)
  if (quoted) text = quoted[2]!.trim()
  if (text === '' || /^none\.?$/i.test(text)) return null
  return [...text].slice(0, SUGGESTION_CHARS).join('')
}

export interface SuggestToolsDeps {
  /**
   * Keeps the message for when the caller's running turn ends; false when the session gives no
   * suggestion now: the setting is off, its agent suggests another way, or no turn runs.
   */
  note(sessionId: string, message: string): boolean
}

/** Serves the tool for the sessions that suggest by it. */
export class SuggestTools {
  constructor(private readonly deps: SuggestToolsDeps) {}

  call(caller: Caller, name: string, input: unknown): CallToolResult {
    if (name !== SUGGEST_TOOL) throw new Error(`Unknown tool ${name}`)
    if (caller.subagent) return failure('Only the main agent suggests the next message.')
    const message = messageOf(input)
    if (message === null) {
      return failure(
        `message must be one line of 1 to ${SUGGESTION_CHARS} characters: the user's likely next message.`,
      )
    }
    if (!this.deps.note(caller.sessionId, message)) {
      return { content: [{ type: 'text', text: 'Not needed in this session.' }] }
    }
    return { content: [{ type: 'text', text: 'Noted: it shows once the turn ends.' }] }
  }
}

function messageOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const keys = Object.keys(input)
  if (keys.length !== 1 || keys[0] !== 'message') return null
  const { message } = input as { message: unknown }
  if (typeof message !== 'string') return null
  const text = message.trim()
  if (text === '' || text.includes('\n') || [...text].length > SUGGESTION_CHARS) return null
  return text
}

function failure(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}
