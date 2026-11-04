// Counts a version's pages when it is written: the tags with a `data-page` attribute in its first
// 2 MiB, found without running or fully parsing the page. The viewer parses it properly.

import { eachStartTag } from '@shared/artifact-source'

export const PAGE_SCAN_BYTES = 2 * 1024 * 1024

/** The start of the text that is scanned: at most `PAGE_SCAN_BYTES` of UTF-8. */
function scanned(html: string): string {
  // A UTF-16 unit is at most 3 bytes of UTF-8, so a short string needs no encoding.
  if (html.length * 3 <= PAGE_SCAN_BYTES) return html
  const bytes = Buffer.from(html, 'utf8')
  return bytes.length <= PAGE_SCAN_BYTES
    ? html
    : bytes.subarray(0, PAGE_SCAN_BYTES).toString('utf8')
}

/**
 * The number of start tags with a `data-page` attribute, outside comments and the text of
 * scripts, styles, titles and text areas, in the first 2 MiB of the HTML.
 */
export function countPages(html: string): number {
  let count = 0
  eachStartTag(scanned(html), (tag) => {
    if (tag.attributes.some((attribute) => attribute.name === 'data-page')) count++
  })
  return count
}
