// What a frame asks of an artifact's origin, and what Kettu serves for it: shared by main's
// artifact protocol and the frames the direct port serves the web client.

import runtimeScript from 'virtual:kettu-page-runtime'
import { ARTIFACT_ENTRY, ARTIFACT_RESERVED } from './artifact-files'
import { markSources, sourceMark } from './artifact-source'
import { RUNTIME_VERSION, type RuntimeConfig } from './artifact-runtime/page-messages'
import { VIEWER_PREFIX } from './artifact-types'

/**
 * One page of a canvas alone: in an old canvas, its group, 0 outside any, and its place in it,
 * both from 1; in a canvas document, the HTML file that is the page, which `file` names.
 */
export interface CanvasPage {
  group: number
  index: number
  file?: string
}

/** The address of a page on its artifact's origin, from its root: its own file, or the entry's. */
export function canvasPagePath(version: number, page: CanvasPage | null): string {
  if (page?.file) return versionUrlPath(version, page.file)
  return `${versionUrlPath(version)}${page ? `?page=${page.group}.${page.index}` : ''}`
}

/** A file of an artifact a request asks for. */
export interface ServedFile {
  /** Null for the latest version. */
  version: number | null
  path: string
  /** For the entry page alone: one page of its canvas, shown by itself. */
  page: CanvasPage | null
}

const VERSION = /^[1-9][0-9]{0,8}$/
const PAGE = /^(0|[1-9][0-9]{0,3})\.([1-9][0-9]{0,3})$/

/**
 * Where a version's files lie on its artifact's origin. A page loads the files beside it by
 * relative paths, which so stay in its version; the origin's other paths are the latest's.
 */
const VERSION_PREFIX = `${ARTIFACT_RESERVED}/v/`

/** The path of a version's file on its artifact's origin, escaped for a URL, from its root. */
export function versionUrlPath(version: number, path: string = ARTIFACT_ENTRY): string {
  return `/${VERSION_PREFIX}${version}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * The file a request's path, as escaped in its URL, and its query ask for, or null for a path
 * that names no file of an artifact. A folder's path stands for the `index.html` in it.
 */
export function parseServed(pathname: string, params: URLSearchParams): ServedFile | null {
  if (!pathname.startsWith('/')) return null
  let rest: string
  try {
    rest = decodeURIComponent(pathname.slice(1))
  } catch {
    return null
  }
  let version: number | null = null
  if (rest.startsWith(VERSION_PREFIX)) {
    const after = rest.slice(VERSION_PREFIX.length)
    const slash = after.indexOf('/')
    if (slash < 0 || !VERSION.test(after.slice(0, slash))) return null
    version = Number(after.slice(0, slash))
    rest = after.slice(slash + 1)
  } else if (rest.startsWith(ARTIFACT_RESERVED) && !rest.startsWith(VIEWER_PREFIX)) {
    // A typed artifact's viewer files are Kettu's own; no other reserved path names a file.
    return null
  }
  const path = rest === '' || rest.endsWith('/') ? `${rest}${ARTIFACT_ENTRY}` : rest
  let page: CanvasPage | null = null
  if (path === ARTIFACT_ENTRY) {
    const pages = params.getAll('page')
    if (pages.length > 1) return null
    if (pages[0] !== undefined) {
      const match = PAGE.exec(pages[0])
      if (!match) return null
      page = { group: Number(match[1]), index: Number(match[2]) }
    }
  }
  return { version, path, page }
}

/**
 * An HTML file of an artifact as a frame gets it: the one place Kettu changes what it serves. Each
 * start tag is marked with its offset, the page runtime comes first, talking over `transport`, and
 * the entry page asked for one canvas page alone gets the style that shows only that page.
 */
export function servedHtml(
  html: string,
  page: CanvasPage | null,
  served: { path: string; transport: RuntimeConfig['transport'] },
): string {
  const mark = sourceMark()
  const marked = markSources(html, mark)
  const styled = page ? withStyle(marked, pageStyle(page.group, page.index)) : marked
  return withRuntime(styled, {
    v: RUNTIME_VERSION,
    transport: served.transport,
    path: served.path,
    mark,
  })
}

/**
 * The HTML with the page runtime first, after any doctype, so it runs before the page's own
 * scripts and any policy the page sets; the script removes itself once it has run.
 */
export function withRuntime(html: string, config: RuntimeConfig): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c')
  const script =
    `<script>(()=>{${runtimeScript};__kettuRuntime.start(${json});` +
    'document.currentScript?.remove()})()</script>'
  const at = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0
  return html.slice(0, at) + script + html.slice(at)
}

/** The style that shows one page of a canvas alone, at the top left; built from checked integers. */
export function pageStyle(group: number, index: number): string {
  const page = `:nth-child(${index} of [data-page])`
  const reset = 'html,body{margin:0!important;padding:0!important}'
  if (group === 0) {
    return `${reset}body>:not(${page}){display:none!important}body>${page}{margin:0!important}`
  }
  const row = `:nth-child(${group} of [data-page-group])`
  return (
    `${reset}body>:not(${row}){display:none!important}body>${row}{display:contents!important}` +
    `body>${row}>:not(${page}){display:none!important}body>${row}>${page}{margin:0!important}`
  )
}

/** The HTML with a style element at the end of its head, or where the parser would put one. */
export function withStyle(html: string, css: string): string {
  const style = `<style>${css}</style>`
  let at = html.search(/<\/head\s*>/i)
  if (at < 0) at = html.search(/<body[\s>]/i)
  if (at < 0) at = /^\s*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0
  return html.slice(0, at) + style + html.slice(at)
}
