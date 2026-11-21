// Maths in a reply beyond remark-math's `$$`: `\[...\]` on lines of their own, a single `$` by
// Pandoc's rule, and `\(...\)` or `\[...\]` within a line.

/** A micromark character code: a character, a line ending (-5 to -3), a tab (-2, -1) or the end. */
type Code = number | null
type State = (code: Code) => State | undefined

interface Effects {
  enter(type: string): { type: string }
  exit(type: string): unknown
  consume(code: Code): void
}

interface TokenizeContext {
  events: Array<[string, { type: string }, unknown]>
}

interface Construct {
  name: string
  tokenize: (this: TokenizeContext, effects: Effects, ok: State, nok: State) => State
  previous?: (this: TokenizeContext, code: Code) => boolean
}

const DOLLAR = 36
const BACKSLASH = 92
// A formula never runs into a code span: `$5. Use \`$HOME\`` keeps its price and its code.
const BACKTICK = 96

function isLineEnding(code: Code): boolean {
  return code !== null && code < -2
}

function isSpace(code: Code): boolean {
  return code === 32 || code === -2 || code === -1 || isLineEnding(code)
}

function isDigit(code: Code): boolean {
  return code !== null && code >= 48 && code <= 57
}

/**
 * `$tex$` by Pandoc's rule, so prices stay text: the opening `$` is followed by a non-space, the
 * closing one follows a non-space and comes before no digit. remark-math's single `$` takes
 * `$5 to $10` as a formula, so it stays off and this construct reads the single `$` instead.
 * Its tokens are remark-math's, which builds the formula from them.
 */
const singleDollar: Construct = {
  name: 'mathTextSingleDollar',
  previous(code) {
    return code !== DOLLAR || this.events[this.events.length - 1]?.[1].type === 'characterEscape'
  },
  tokenize(effects, ok, nok) {
    let afterSpace = false
    const start: State = (code) => {
      effects.enter('mathText')
      effects.enter('mathTextSequence')
      effects.consume(code)
      effects.exit('mathTextSequence')
      return open
    }
    const open: State = (code) => {
      // `$$` is remark-math's.
      if (code === null || code === DOLLAR || code === BACKTICK || isSpace(code)) return nok(code)
      effects.enter('mathTextData')
      return data(code)
    }
    const data: State = (code) => {
      if (code === null || code === BACKTICK) return nok(code)
      if (code === DOLLAR) {
        if (afterSpace) return nok(code)
        effects.exit('mathTextData')
        effects.enter('mathTextSequence')
        effects.consume(code)
        effects.exit('mathTextSequence')
        effects.exit('mathText')
        return close
      }
      if (isLineEnding(code)) {
        effects.exit('mathTextData')
        effects.enter('lineEnding')
        effects.consume(code)
        effects.exit('lineEnding')
        afterSpace = true
        return lineStart
      }
      afterSpace = isSpace(code)
      effects.consume(code)
      return code === BACKSLASH ? escaped : data
    }
    const escaped: State = (code) => {
      if (code === null || code === BACKTICK || isLineEnding(code)) return data(code)
      effects.consume(code)
      return data
    }
    const lineStart: State = (code) => {
      if (code === null || code === DOLLAR || code === BACKTICK) return nok(code)
      if (isLineEnding(code)) {
        effects.enter('lineEnding')
        effects.consume(code)
        effects.exit('lineEnding')
        return lineStart
      }
      effects.enter('mathTextData')
      return data(code)
    }
    const close: State = (code) => (isDigit(code) ? nok(code) : ok(code))
    return start
  },
}

/**
 * `\(tex\)` or `\[tex\]` within a line, read before `\(` would be an escaped parenthesis. A
 * `\[...\]` on lines of its own was made a `$$` block before parsing (fenceBracketMath).
 */
const backslashPair: Construct = {
  name: 'mathTextBackslash',
  tokenize(effects, ok, nok) {
    let closer = 0
    let empty = true
    let sequence: { type: string } | null = null
    const start: State = (code) => {
      effects.enter('mathText')
      effects.enter('mathTextSequence')
      effects.consume(code)
      return opener
    }
    const opener: State = (code) => {
      if (code !== 40 && code !== 91) return nok(code)
      closer = code === 40 ? 41 : 93
      effects.consume(code)
      effects.exit('mathTextSequence')
      return between
    }
    const between: State = (code) => {
      if (code === null || code === BACKTICK) return nok(code)
      if (code === BACKSLASH) {
        sequence = effects.enter('mathTextSequence')
        effects.consume(code)
        return sequenceEnd
      }
      if (isLineEnding(code)) {
        effects.enter('lineEnding')
        effects.consume(code)
        effects.exit('lineEnding')
        return between
      }
      effects.enter('mathTextData')
      return data(code)
    }
    const data: State = (code) => {
      if (code === null || code === BACKSLASH || code === BACKTICK || isLineEnding(code)) {
        effects.exit('mathTextData')
        return between(code)
      }
      empty = false
      effects.consume(code)
      return data
    }
    const sequenceEnd: State = (code) => {
      if (code === closer) {
        if (empty) return nok(code)
        effects.consume(code)
        effects.exit('mathTextSequence')
        effects.exit('mathText')
        return ok
      }
      // Not the end: the backslash and what it escapes are part of the formula.
      sequence!.type = 'mathTextData'
      empty = false
      if (code === null || code === BACKTICK || isLineEnding(code)) {
        effects.exit('mathTextData')
        return between(code)
      }
      effects.consume(code)
      effects.exit('mathTextData')
      return between
    }
    return start
  },
}

/** The remark plugin: after remark-math, whose tokens these constructs make. */
export function replyMath(this: { data(): object }) {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  ;(data.micromarkExtensions ??= []).push({
    text: { [DOLLAR]: singleDollar, [BACKSLASH]: backslashPair },
  })
}

const FENCE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})/
// A `\[` that starts a line, after any quote markers and a list item's marker.
const OPEN = /^((?:[ \t]*>)*[ \t]*)((?:[-*+]|\d{1,9}[.)])[ \t]+)?\\\[/
const LIST_ITEM = /^(?:[ \t]*>)*[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const ONLY_PREFIX = /^(?:[ \t]*>)*[ \t]*$/
const CLOSE = '\\]'

function indentOf(line: string): number {
  let width = 0
  for (const char of line) {
    if (char === ' ') width += 1
    else if (char === '\t') width += 4 - (width % 4)
    else break
  }
  return width
}

/**
 * Writes each `\[...\]` that starts a line and ends one as a `$$` block, the form the renderer
 * splits and parses as one formula: Markdown would take `\[` as an escaped bracket and the lines
 * between as text, and a line in it starting with `+` or `-` as a list. Code blocks and lines
 * indented as code stay as written. While `live`, a `\[` that has not closed yet becomes an open
 * block, which shows its source until it does.
 */
export function fenceBracketMath(markdown: string, live: boolean): string {
  if (!markdown.includes('\\[')) return markdown
  const lines = markdown.split(/(?<=\n)/)
  let out = ''
  let fence: string | null = null
  let inList = false
  let blankBefore = true
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const body = line.replace(/\r?\n$/, '')
    if (fence !== null) {
      out += line
      const close = FENCE.exec(body)
      if (
        close &&
        close[1]![0] === fence[0] &&
        close[1]!.length >= fence.length &&
        body.slice(close[0].length).trim() === ''
      ) {
        fence = null
      }
      continue
    }
    const fenceOpen = FENCE.exec(body)
    if (fenceOpen) {
      fence = fenceOpen[1]!
      out += line
      blankBefore = false
      continue
    }
    const blank = body.trim() === ''
    if (!blank) {
      if (LIST_ITEM.test(body)) inList = true
      else if (indentOf(body) === 0 && blankBefore) inList = false
    }
    const open = OPEN.exec(body)
    const indentedCode = blankBefore && !inList && indentOf(body) >= 4
    blankBefore = blank
    if (!open || indentedCode) {
      out += line
      continue
    }
    const block = bracketBlock(lines, i, open)
    if (block === null || (!block.closed && !live)) {
      out += line
      continue
    }
    out += block.text
    i = block.end
    blankBefore = false
    if (!block.closed) break
  }
  return out
}

/** The `$$` block for the `\[` on `lines[start]`, or null when its first `\]` ends no line. */
function bracketBlock(
  lines: string[],
  start: number,
  open: RegExpExecArray,
): { text: string; end: number; closed: boolean } | null {
  const [opener, quote, marker = ''] = open as unknown as [string, string, string | undefined]
  // Lines added to the block keep its quote markers and line up with the list item's text.
  const prefix = quote + ' '.repeat(marker.length)
  const first = lines[start]!
  const firstEnd = first.endsWith('\n') ? (first.endsWith('\r\n') ? '\r\n' : '\n') : ''
  let text = `${quote}${marker}$$\n`
  let rest = first.slice(opener.length, first.length - firstEnd.length)
  let eol = firstEnd
  for (let j = start; j < lines.length; j++) {
    if (j > start) {
      const line = lines[j]!
      eol = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
      rest = line.slice(0, line.length - eol.length)
    }
    const at = rest.indexOf(CLOSE)
    if (at === -1) {
      if (j > start || rest.trim() !== '') text += `${j > start ? '' : prefix}${rest}${eol || ''}`
      if (!eol) text += '\n'
      continue
    }
    if (rest.slice(at + CLOSE.length).trim() !== '') return null
    const before = rest.slice(0, at)
    if (ONLY_PREFIX.test(before)) {
      text += j > start ? `${before}$$${eol}` : `${prefix}$$${eol}`
    } else {
      text += `${j > start ? '' : prefix}${before}\n${prefix}$$${eol}`
    }
    return { text, end: j, closed: true }
  }
  return { text, end: lines.length - 1, closed: false }
}
