export type UserMessageSegment =
  | { kind: 'text'; text: string; offset: number }
  | {
      kind: 'code'
      language: string
      meta: string
      code: string
      raw: string
      offset: number
    }

interface LineSpan {
  /** Line content without its trailing line break. */
  content: string
  /** Start offset of the line in the original string. */
  start: number
  /** End offset of the line content (excluding `\r?\n`). */
  contentEnd: number
  /** End offset of the line including its trailing `\r?\n`. */
  end: number
}

const OPENING_FENCE = /^([ ]{0,3})(`{3,}|~{3,})([^\r\n]*)$/

function splitLineSpans(text: string): LineSpan[] {
  const lines: LineSpan[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n' || ch === '\r') {
      const next = ch === '\r' && text[i + 1] === '\n' ? i + 2 : i + 1
      lines.push({ content: text.slice(start, i), start, contentEnd: i, end: next })
      start = next
      i = next - 1
    }
  }
  if (start < text.length || lines.length === 0) {
    lines.push({ content: text.slice(start), start, contentEnd: text.length, end: text.length })
  }
  return lines
}

function parseOpeningFence(
  line: string,
): { char: '`' | '~'; length: number; language: string; meta: string } | null {
  const match = OPENING_FENCE.exec(line)
  if (!match) return null
  const fence = match[2]!
  const char = fence[0] as '`' | '~'
  const info = match[3]!.trim()
  // CommonMark: backtick info strings cannot contain backticks (prevents matching inline ```` ```foo``` ````).
  if (char === '`' && info.includes('`')) return null
  const split = /\s/.exec(info)
  const language = split ? info.slice(0, split.index) : info
  const meta = split ? info.slice(split.index).trim() : ''
  return { char, length: fence.length, language, meta }
}

function isClosingFence(line: string, char: '`' | '~', minLength: number): boolean {
  let i = 0
  let spaces = 0
  while (i < line.length && line[i] === ' ' && spaces < 3) {
    i++
    spaces++
  }
  let count = 0
  while (i < line.length && line[i] === char) {
    i++
    count++
  }
  if (count < minLength) return false
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return false
    i++
  }
  return true
}

/**
 * Splits a sent user message into verbatim text segments and explicit fenced code blocks.
 *
 * Only properly opened and closed fences (3+ backticks or tildes on their own lines) become code
 * blocks; unclosed fences and all other Markdown-like syntax stay verbatim text so terminal
 * pastes, logs, and commands match what the user wrote in the composer.
 */
export function splitUserMessageSegments(text: string): UserMessageSegment[] {
  if (!text) return []
  const lines = splitLineSpans(text)
  const segments: UserMessageSegment[] = []
  let textStartLine = 0

  const flushText = (endLine: number, trimLeadingBreaks: boolean, trimTrailingBreaks: boolean) => {
    if (textStartLine >= endLine) return
    let sliceStart = lines[textStartLine]!.start
    let slice = text.slice(sliceStart, lines[endLine - 1]!.end)
    if (trimLeadingBreaks) {
      const lead = /^(?:\r?\n)+/.exec(slice)
      if (lead) {
        sliceStart += lead[0].length
        slice = slice.slice(lead[0].length)
      }
    }
    if (trimTrailingBreaks) {
      const trail = /(?:\r?\n)+$/.exec(slice)
      if (trail) {
        slice = slice.slice(0, slice.length - trail[0].length)
      }
    }
    if (slice.length > 0) {
      segments.push({ kind: 'text', text: slice, offset: sliceStart })
    }
  }

  let hasCodeBlock = false
  for (let i = 0; i < lines.length; i++) {
    const open = parseOpeningFence(lines[i]!.content)
    if (!open) continue

    let closeIndex = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (isClosingFence(lines[j]!.content, open.char, open.length)) {
        closeIndex = j
        break
      }
    }
    if (closeIndex < 0) continue

    flushText(i, hasCodeBlock, true)
    hasCodeBlock = true

    const bodyStart = i + 1 < closeIndex ? lines[i + 1]!.start : lines[closeIndex]!.start
    const bodyEnd = i + 1 < closeIndex ? lines[closeIndex - 1]!.contentEnd : bodyStart
    const code = text.slice(bodyStart, bodyEnd)
    const raw = text.slice(lines[i]!.start, lines[closeIndex]!.contentEnd)

    segments.push({
      kind: 'code',
      language: open.language,
      meta: open.meta,
      code,
      raw,
      offset: lines[i]!.start,
    })

    textStartLine = closeIndex + 1
    i = closeIndex
  }

  if (!hasCodeBlock) {
    return [{ kind: 'text', text, offset: 0 }]
  }

  flushText(lines.length, true, false)
  return segments
}
