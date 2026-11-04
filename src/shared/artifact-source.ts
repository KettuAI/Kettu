// The start tags of an artifact's HTML as written, found without running or fully parsing it:
// the agent host counts pages with them, and every client that serves a page marks each element
// with where its start tag lies, which comments and direct edits point back to.

/** The attribute each start tag gets as it is served: its offset in the file, in UTF-16 units. */
export const SOURCE_ATTRIBUTE = 'data-kettu-src'

// Their text is not markup, so a tag inside one is no element.
const RAW_TEXT = new Map(
  ['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].map(
    (name) => [name, new RegExp(`</${name}[\\s/>]`, 'gi')],
  ),
)

/** Elements that never have content. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])

function isSpace(c: number): boolean {
  // Tab, line feed, form feed, carriage return and space, as HTML's tokenizer has them.
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d
}

function isLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
}

export interface SourceAttribute {
  /** Lowercase. */
  name: string
  start: number
  /** Where the attribute ends, after its value if it has one. */
  end: number
  /** The value as written, between its quotes; null for an attribute without one. */
  value: string | null
}

export interface StartTag {
  /** The offset of its `<`. */
  start: number
  /** Lowercase. */
  name: string
  nameEnd: number
  /** After its `>`. */
  end: number
  attributes: SourceAttribute[]
}

/** A start tag's attributes, read from after its name, and where the tag ends; null if it never does. */
function readAttributes(
  text: string,
  from: number,
): { end: number; attributes: SourceAttribute[] } | null {
  const n = text.length
  const attributes: SourceAttribute[] = []
  let i = from
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 0x3e) return { end: i + 1, attributes }
    if (isSpace(c) || c === 0x2f) {
      i++
      continue
    }
    const start = i
    // A name may begin with "=", as the tokenizer reads it; after that "=" starts the value.
    i++
    while (i < n) {
      const d = text.charCodeAt(i)
      if (isSpace(d) || d === 0x2f || d === 0x3e || d === 0x3d) break
      i++
    }
    const name = text.slice(start, i).toLowerCase()
    let j = i
    while (j < n && isSpace(text.charCodeAt(j))) j++
    if (text.charCodeAt(j) !== 0x3d) {
      attributes.push({ name, start, end: i, value: null })
      continue
    }
    j++
    while (j < n && isSpace(text.charCodeAt(j))) j++
    const quote = text.charCodeAt(j)
    if (quote === 0x22 || quote === 0x27) {
      const close = text.indexOf(text.charAt(j), j + 1)
      if (close < 0) return null
      attributes.push({ name, start, end: close + 1, value: text.slice(j + 1, close) })
      i = close + 1
    } else {
      const valueStart = j
      while (j < n && !isSpace(text.charCodeAt(j)) && text.charCodeAt(j) !== 0x3e) j++
      attributes.push({ name, start, end: j, value: text.slice(valueStart, j) })
      i = j
    }
  }
  return null
}

/**
 * Calls `visit` with each start tag written in the HTML, in order, outside comments and the text
 * of raw text elements such as scripts, styles and text areas; `visit` returning false stops.
 */
export function eachStartTag(html: string, visit: (tag: StartTag) => boolean | void): void {
  const n = html.length
  let i = 0
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0 || lt + 1 >= n) return
    const next = html.charCodeAt(lt + 1)
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end < 0) return
      i = end + 3
      continue
    }
    if (next === 0x2f || next === 0x21 || next === 0x3f) {
      // An end tag, a doctype or a processing instruction: no element starts in it.
      const end = html.indexOf('>', lt + 2)
      if (end < 0) return
      i = end + 1
      continue
    }
    if (!isLetter(next)) {
      i = lt + 1
      continue
    }
    let nameEnd = lt + 2
    while (nameEnd < n) {
      const c = html.charCodeAt(nameEnd)
      if (isSpace(c) || c === 0x2f || c === 0x3e) break
      nameEnd++
    }
    const read = readAttributes(html, nameEnd)
    // A tag the text ends inside is no element.
    if (!read) return
    const name = html.slice(lt + 1, nameEnd).toLowerCase()
    if (visit({ start: lt, name, nameEnd, end: read.end, attributes: read.attributes }) === false) {
      return
    }
    i = read.end
    if (name === 'plaintext') return
    const close = RAW_TEXT.get(name)
    if (close) {
      close.lastIndex = read.end
      if (!close.exec(html)) return
      i = close.lastIndex - 1
    }
  }
}

/** The start tag that begins at `offset`, as `eachStartTag` finds it, or null. */
export function startTagAt(html: string, offset: number): StartTag | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || html.charCodeAt(offset) !== 0x3c) return null
  let found: StartTag | null = null
  eachStartTag(html, (tag) => {
    if (tag.start < offset) return
    if (tag.start === offset) found = tag
    return false
  })
  return found
}

/**
 * The HTML with each start tag marked with `mark` and its offset, as a frame is served it. The
 * mark is new for each response, so the page runtime can tell its own document's elements from
 * markup a page fetched from another file and put in it.
 */
export function markSources(html: string, mark: string): string {
  let out = ''
  let from = 0
  eachStartTag(html, (tag) => {
    out += `${html.slice(from, tag.nameEnd)} ${SOURCE_ATTRIBUTE}="${mark}:${tag.start}"`
    from = tag.nameEnd
  })
  return from === 0 ? html : out + html.slice(from)
}

/** A new mark for `markSources`: eight lowercase letters and digits. */
export function sourceMark(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('')
}

export function isVoidElement(name: string): boolean {
  return VOID.has(name)
}

/**
 * Where the text of the element whose start tag is `tag` lies, when its content is text alone,
 * up to its end tag; null for an element with child elements, comments or no end tag.
 */
export function textContentRange(
  html: string,
  tag: StartTag,
): { start: number; end: number } | null {
  if (VOID.has(tag.name) || RAW_TEXT.has(tag.name) || tag.name === 'template') return null
  const lt = html.indexOf('<', tag.end)
  if (lt < 0) return null
  const close = `</${tag.name}`
  if (html.slice(lt, lt + close.length).toLowerCase() !== close) return null
  const after = html.charCodeAt(lt + close.length)
  if (!(isSpace(after) || after === 0x3e || after === 0x2f)) return null
  return { start: tag.end, end: lt }
}

/** The page each start tag lies in, as reading order numbers them from 1; 0 before the first. */
export function pageStarts(html: string): number[] {
  const starts: number[] = []
  eachStartTag(html, (tag) => {
    if (tag.attributes.some((a) => a.name === 'data-page')) starts.push(tag.start)
  })
  return starts
}

/** The page number, from 1, of the page whose start tag is the last before `offset`; 0 for none. */
export function pageOf(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (starts[mid]! <= offset) low = mid + 1
    else high = mid
  }
  return low
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Text as HTML would show it, near enough to match a page's report: entities, then spaces. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body: string) => {
      if (body[0] === '#') {
        const code =
          body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1))
        return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : entity
      }
      return ENTITIES[body.toLowerCase()] ?? entity
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** How much of the source after a start tag is read to compare its text with a snippet. */
const TEXT_WINDOW = 2_000

/**
 * The start tag a comment's anchor names in a new version of its file: one with the same tag
 * name whose text begins with the snippet, in the same page if there is one, nearest the old
 * offset. Null when none matches or the anchor has no text to match by.
 */
export function findAnchor(
  html: string,
  anchor: { offset: number; tag: string; text: string; page: number | null },
): number | null {
  const snippet = plainText(anchor.text)
  if (snippet === '') return null
  const starts = pageStarts(html)
  let best: { offset: number; samePage: boolean; distance: number } | null = null
  eachStartTag(html, (tag) => {
    if (tag.name !== anchor.tag) return
    const text = plainText(html.slice(tag.end, tag.end + TEXT_WINDOW))
    if (!text.startsWith(snippet)) return
    const candidate = {
      offset: tag.start,
      samePage: anchor.page !== null && pageOf(starts, tag.start) === anchor.page,
      distance: Math.abs(tag.start - anchor.offset),
    }
    if (
      !best ||
      (candidate.samePage && !best.samePage) ||
      (candidate.samePage === best.samePage && candidate.distance < best.distance)
    ) {
      best = candidate
    }
  })
  return (best as { offset: number } | null)?.offset ?? null
}
