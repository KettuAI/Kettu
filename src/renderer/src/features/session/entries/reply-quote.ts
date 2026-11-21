// A comment on a passage goes as the passage in a Markdown blockquote with the comment after it.

const QUOTE_LIMIT = 2000

/** A passage as a blockquote; a line of its own that starts with `>` stays text in the quote. */
function quoteBlock(passage: string): string {
  let quoted = passage
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (quoted.length > QUOTE_LIMIT) quoted = `${quoted.slice(0, QUOTE_LIMIT).trimEnd()}…`
  return quoted
    .split('\n')
    .map((line) => (line ? `> ${line.replace(/^( {0,3})>/, '$1\\>')}` : '>'))
    .join('\n')
}

/**
 * The message the composer sends with comments: each passage quoted with its comment after it, in
 * the order given, then the composer's text. Without comments, the text as it is.
 */
export function commentsMessage(
  comments: readonly { passage: string; comment: string }[],
  text: string,
): string {
  if (comments.length === 0) return text
  const parts = comments.map((c) => `${quoteBlock(c.passage)}\n\n${c.comment.trim()}`)
  if (text.trim()) parts.push(text.trim())
  return parts.join('\n\n')
}

/** The quote a message starts with, without its markers, and the text after it. */
export function splitQuote(text: string): { quote: string; rest: string } | null {
  const lines = text.split('\n')
  let end = 0
  while (end < lines.length && lines[end]!.startsWith('>')) end++
  if (end === 0) return null
  const quote = lines
    .slice(0, end)
    .map((line) => line.replace(/^> ?/, ''))
    .join('\n')
    .trim()
  if (!quote) return null
  return {
    quote,
    rest: lines
      .slice(end)
      .join('\n')
      .replace(/^\s*\n/, ''),
  }
}
