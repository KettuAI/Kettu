// What a published page carries: the artifacts' network policy, no referrer and no indexing, in
// its headers and again at the top of its HTML, for a target that cannot set headers.

import { ARTIFACT_CSP } from '../artifacts/policy'

/** `frame-ancestors` works only as a header, so the `<meta>` policy leaves it out. */
export const PUBLISHED_CSP = `${ARTIFACT_CSP}; frame-ancestors 'none'`

export function pageHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': PUBLISHED_CSP,
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }
}

/** A `_headers` file that sends the headers with every path. */
export function headersFile(headers: Record<string, string>): string {
  const lines = Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`)
  return ['/*', ...lines, ''].join('\n')
}

const META =
  `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
  '<meta name="robots" content="noindex">'

/** The HTML with the policy and `noindex` first in its head, or where the parser starts one. */
export function withMeta(html: string): string {
  const at = insertionPoint(html)
  return html.slice(0, at) + META + html.slice(at)
}

const PROLOG_TAG = /<(!doctype|html|head)(?=[\s/>])[^>]*>/iy

/**
 * Right after `<head>`, or else after `<html>` or the doctype, read from the document's start
 * past comments only, so a `<head>` in a comment, a script or the body is never taken for it.
 */
function insertionPoint(html: string): number {
  let at = html.charCodeAt(0) === 0xfeff ? 1 : 0
  let point = at
  for (;;) {
    while (at < html.length && /\s/.test(html[at]!)) at++
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4)
      if (end < 0) return point
      at = end + 3
      continue
    }
    if (html.startsWith('<?', at)) {
      const end = html.indexOf('>', at)
      if (end < 0) return point
      at = end + 1
      continue
    }
    PROLOG_TAG.lastIndex = at
    const tag = PROLOG_TAG.exec(html)
    if (!tag) return point
    at += tag[0].length
    point = at
    if (tag[1]!.toLowerCase() === 'head') return point
  }
}
