// Counts a version's pages when it is written: the tags with a `data-page` attribute in its first
// 2 MiB, found without running or fully parsing the page. The viewer parses it properly.

export const PAGE_SCAN_BYTES = 2 * 1024 * 1024

// Their text is not markup, so a tag inside one is not a page.
const RAW_TEXT = new Map(
  ['script', 'style', 'textarea', 'title'].map((name) => [name, new RegExp(`</${name}`, 'gi')]),
)

function isSpace(c: number): boolean {
  // Tab, line feed, form feed, carriage return and space, as HTML's tokenizer has them.
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d
}

function isLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
}

/** The start of the text that is scanned: at most `PAGE_SCAN_BYTES` of UTF-8. */
function scanned(html: string): string {
  // A UTF-16 unit is at most 3 bytes of UTF-8, so a short string needs no encoding.
  if (html.length * 3 <= PAGE_SCAN_BYTES) return html
  const bytes = Buffer.from(html, 'utf8')
  return bytes.length <= PAGE_SCAN_BYTES
    ? html
    : bytes.subarray(0, PAGE_SCAN_BYTES).toString('utf8')
}

/** A start tag's attributes, read from after its name: where the tag ends, and if it is a page. */
function readAttributes(text: string, from: number): { end: number; page: boolean } {
  const n = text.length
  let i = from
  let page = false
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 0x3e) return { end: i + 1, page }
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
    if (i - start === 9 && text.slice(start, i).toLowerCase() === 'data-page') page = true
    let j = i
    while (j < n && isSpace(text.charCodeAt(j))) j++
    if (text.charCodeAt(j) !== 0x3d) continue
    j++
    while (j < n && isSpace(text.charCodeAt(j))) j++
    const quote = text.charCodeAt(j)
    if (quote === 0x22 || quote === 0x27) {
      const close = text.indexOf(text.charAt(j), j + 1)
      if (close < 0) return { end: n, page: false }
      i = close + 1
    } else {
      while (j < n && !isSpace(text.charCodeAt(j)) && text.charCodeAt(j) !== 0x3e) j++
      i = j
    }
  }
  // A tag the text ends inside is no element.
  return { end: n, page: false }
}

/**
 * The number of start tags with a `data-page` attribute, outside comments and the text of
 * scripts, styles, titles and text areas, in the first 2 MiB of the HTML.
 */
export function countPages(html: string): number {
  const text = scanned(html)
  const n = text.length
  let count = 0
  let i = 0
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0 || lt + 1 >= n) break
    const next = text.charCodeAt(lt + 1)
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end < 0) break
      i = end + 3
      continue
    }
    if (next === 0x2f || next === 0x21 || next === 0x3f) {
      // An end tag, a doctype or a processing instruction: nothing in it marks a page.
      const end = text.indexOf('>', lt + 2)
      if (end < 0) break
      i = end + 1
      continue
    }
    if (!isLetter(next)) {
      i = lt + 1
      continue
    }
    let nameEnd = lt + 2
    while (nameEnd < n) {
      const c = text.charCodeAt(nameEnd)
      if (isSpace(c) || c === 0x2f || c === 0x3e) break
      nameEnd++
    }
    const { end, page } = readAttributes(text, nameEnd)
    if (page) count++
    i = end
    const close = RAW_TEXT.get(text.slice(lt + 1, nameEnd).toLowerCase())
    if (close) {
      close.lastIndex = end
      if (!close.exec(text)) break
      i = close.lastIndex
    }
  }
  return count
}
