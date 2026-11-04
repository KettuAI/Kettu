// A reply to a passage is a message that starts with the passage as a Markdown blockquote.

const QUOTE_LIMIT = 2000

/** The message a reply sends: the passage quoted, a blank line, then the answer. */
export function replyMessage(passage: string, answer: string): string {
  let quoted = passage
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (quoted.length > QUOTE_LIMIT) quoted = `${quoted.slice(0, QUOTE_LIMIT).trimEnd()}…`
  const lines = quoted.split('\n').map((line) => (line ? `> ${line}` : '>'))
  return `${lines.join('\n')}\n\n${answer.trim()}`
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
