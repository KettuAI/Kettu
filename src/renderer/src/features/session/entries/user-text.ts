import type { UserContent } from '@shared/thread'

/**
 * Full copyable text of a user prompt: every text part and link URI joined by newlines, matching
 * the user message's Copy action.
 */
export function userText(content: readonly UserContent[]): string {
  return content
    .map((c) => (c.type === 'text' ? c.text : c.ref.kind === 'link' ? c.ref.uri : ''))
    .filter(Boolean)
    .join('\n')
}
