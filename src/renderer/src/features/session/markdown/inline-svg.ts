// Inline `<svg>` in a reply, rewritten as an `svg` code block before the text is parsed.

// As raw HTML the sanitizer drops its tags and keeps their text, and a blank line inside it ends
// the HTML block, so the rest of the picture shows as text and code.

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const OPEN = /^ {0,3}<svg(?=[\s>/])/i
const TAG = /<(\/?)svg(?=[\s>/])/gi

/** Where the `<svg>` element that starts on `line` ends, as an index, or -1 when it goes on. */
function elementEnd(line: string, depth: { value: number }): number {
  for (const tag of line.matchAll(TAG)) {
    if (tag[1] === '/') {
      depth.value -= 1
    } else {
      const close = line.indexOf('>', tag.index)
      if (close === -1 || line[close - 1] !== '/') depth.value += 1
    }
    if (depth.value <= 0) return line.indexOf('>', tag.index) + 1
  }
  return -1
}

/**
 * Writes each `<svg>` element that starts a line as an `svg` code block, which draws it as a
 * picture. Code blocks and lines indented as code stay as written. While `live`, an element that
 * has not closed yet becomes an open block, so it never shows as text first; a finished text
 * leaves one that never closes alone, so it does not swallow what follows.
 */
export function fenceInlineSvg(markdown: string, live: boolean): string {
  if (!/<svg[\s>/]/i.test(markdown)) return markdown
  const lines = markdown.split(/(?<=\n)/)
  let out = ''
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence !== null) {
      out += line
      const close = FENCE.exec(line)
      if (
        close !== null &&
        close[1]![0] === fence[0] &&
        close[1]!.length >= fence.length &&
        line.slice(close[0].length).trim() === ''
      ) {
        fence = null
      }
      continue
    }
    const open = FENCE.exec(line)
    if (open) {
      fence = open[1]!
      out += line
      continue
    }
    if (!OPEN.test(line)) {
      out += line
      continue
    }
    const depth = { value: 0 }
    let element = ''
    let rest = ''
    let closed = false
    for (let j = i; j < lines.length && !closed; j++) {
      const end = elementEnd(lines[j]!, depth)
      if (end === -1) {
        element += lines[j]
        continue
      }
      element += lines[j]!.slice(0, end)
      rest = lines[j]!.slice(end)
      closed = true
      i = j
    }
    if (!closed && !live) {
      out += line
      continue
    }
    const ticks = '`'.repeat(Math.max(3, longestRun(element) + 1))
    out += `${ticks}svg\n${element}`
    if (!closed) break
    out += `${element.endsWith('\n') ? '' : '\n'}${ticks}\n`
    if (rest.trim() !== '') out += rest.replace(/^\s+/, '')
  }
  return out
}

function longestRun(text: string): number {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return longest
}
