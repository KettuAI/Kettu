// What a frame asks of an artifact's page, and how one page of a canvas is shown alone: shared by
// main's artifact protocol and the web client's frames.

export interface ArtifactQuery {
  /** Null for the latest. */
  version: number | null
  /** One page of a canvas alone: its group, 0 outside any, and its place in it, both from 1. */
  page: { group: number; index: number } | null
}

const VERSION = /^[1-9][0-9]{0,8}$/
const PAGE = /^(0|[1-9][0-9]{0,3})\.([1-9][0-9]{0,3})$/

/** The version and page a frame's query asks for, or null for a query no frame sends. */
export function parseArtifactQuery(params: URLSearchParams): ArtifactQuery | null {
  const versions = params.getAll('v')
  const pages = params.getAll('page')
  if (versions.length > 1 || pages.length > 1) return null
  const [v] = versions
  const [p] = pages
  if (v !== undefined && !VERSION.test(v)) return null
  const page = p === undefined ? null : PAGE.exec(p)
  if (p !== undefined && !page) return null
  return {
    version: v === undefined ? null : Number(v),
    page: page ? { group: Number(page[1]), index: Number(page[2]) } : null,
  }
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
