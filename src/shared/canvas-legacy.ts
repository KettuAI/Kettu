// Canvases written before the canvas document: one `index.html` whose body's children, or the
// children of its `data-page-group` children, are pages marked with `data-page`. They open as they
// are; the first change made on the canvas itself splits one into a canvas document and a file per
// page, each with the original head and the scripts and styles of the original body.

import {
  CANVAS_FORMAT,
  DEFAULT_PAGE,
  PAGE_GAP,
  PAGE_MAX,
  PAGE_MIN,
  SECTION_GAP,
  SECTION_HEAD,
  type CanvasDoc,
  type CanvasPage,
  type CanvasSection,
} from './canvas-doc'
import { eachStartTag, elementEnd, type StartTag } from './artifact-source'

/** How many pages a row of an old canvas held before it wrapped. */
const ROW_PAGES = 6
const SIZE = /^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$/i

function attribute(tag: StartTag, name: string): string | null {
  const found = tag.attributes.find((a) => a.name === name)
  return found ? (found.value ?? '') : null
}

function sizeOf(tag: StartTag): { width: number; height: number } {
  const match = SIZE.exec(attribute(tag, 'data-page-size') ?? '')
  if (!match) return DEFAULT_PAGE
  const clamp = (n: number): number => Math.min(PAGE_MAX, Math.max(PAGE_MIN, n))
  return { width: clamp(Number(match[1])), height: clamp(Number(match[2])) }
}

/** The start tags of the elements directly inside `parent`, with where each one ends. */
function children(
  html: string,
  tags: readonly StartTag[],
  from: number,
  to: number,
): Array<{ tag: StartTag; end: number }> {
  const out: Array<{ tag: StartTag; end: number }> = []
  let at = from
  for (const tag of tags) {
    if (tag.start < at) continue
    if (tag.start >= to) break
    const end = elementEnd(html, tag) ?? to
    out.push({ tag, end })
    at = end
  }
  return out
}

/** A file name from a page's name: plain letters and digits, else its number. */
function slug(name: string, n: number): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return s === '' ? `page-${n}` : s
}

export interface LegacySplit {
  doc: CanvasDoc
  /** Each page's new file, by its path. */
  files: Map<string, string>
}

/** Whether an entry page is an old canvas: two or more pages marked where a canvas puts them. */
export function isLegacyCanvas(html: string): boolean {
  return legacyPages(html).length >= 2
}

interface LegacyPage {
  tag: StartTag
  end: number
  group: { title: string | null; n: number } | null
}

function legacyPages(html: string): LegacyPage[] {
  const tags: StartTag[] = []
  eachStartTag(html, (tag) => {
    tags.push(tag)
  })
  const body = tags.find((t) => t.name === 'body')
  if (!body) return []
  const bodyEnd = elementEnd(html, body) ?? html.length
  const pages: LegacyPage[] = []
  let groups = 0
  for (const child of children(html, tags, body.end, bodyEnd)) {
    if (attribute(child.tag, 'data-page') !== null) {
      pages.push({ ...child, group: null })
    } else if (attribute(child.tag, 'data-page-group') !== null) {
      const group = { title: attribute(child.tag, 'data-page-group')!.trim() || null, n: ++groups }
      for (const inner of children(html, tags, child.tag.end, child.end)) {
        if (attribute(inner.tag, 'data-page') !== null) pages.push({ ...inner, group })
      }
    }
  }
  return pages
}

/**
 * The canvas document and page files for an old canvas, laid out as the old canvas showed it:
 * rows of up to six pages, each group a section. `taken` holds the paths already in the version.
 */
export function splitLegacyCanvas(html: string, taken: ReadonlySet<string>): LegacySplit | null {
  const pages = legacyPages(html)
  if (pages.length < 2) return null
  const tags: StartTag[] = []
  eachStartTag(html, (tag) => {
    tags.push(tag)
  })
  const root = tags.find((t) => t.name === 'html')
  const head = tags.find((t) => t.name === 'head')
  const body = tags.find((t) => t.name === 'body')!
  const bodyEnd = elementEnd(html, body) ?? html.length
  // A head written without its end tag ends where the body starts.
  const headEnd = head ? (elementEnd(html, head) ?? body.start) : null
  const headInner =
    head && headEnd !== null ? html.slice(head.end, headEnd).replace(/<\/head\s*>$/i, '') : ''
  const attrs = (tag: StartTag | undefined): string =>
    tag ? html.slice(tag.nameEnd, tag.end - 1).replace(/\/$/, '') : ''
  // The body's scripts, styles and templates run on every page, as they did on the old canvas.
  const shared = children(html, tags, body.end, bodyEnd)
    .filter((c) => ['script', 'style', 'template', 'link', 'meta', 'noscript'].includes(c.tag.name))
    .map((c) => html.slice(c.tag.start, c.end))
    .join('\n')

  const used = new Set(taken)
  const files = new Map<string, string>()
  const sections: CanvasSection[] = []
  const placed: CanvasPage[] = []
  let rowY = 0
  let rowX = 0
  let rowHeight = 0
  let inRow = 0
  let lastGroup: number | null = -1
  let n = 0
  for (const page of pages) {
    n++
    const name = attribute(page.tag, 'data-page')!.trim() || `Page ${n}`
    const group = page.group?.n ?? 0
    if (group !== lastGroup || inRow === ROW_PAGES) {
      if (inRow > 0) {
        rowY += rowHeight + (group !== lastGroup ? SECTION_GAP + SECTION_HEAD : PAGE_GAP)
      }
      rowX = 0
      rowHeight = 0
      inRow = 0
      if (group !== lastGroup && page.group) {
        sections.push({
          id: `s${page.group.n}`,
          canvas: 'canvas-1',
          title: page.group.title ?? `Group ${page.group.n}`,
        })
      }
      lastGroup = group
    }
    const { width, height } = sizeOf(page.tag)
    // Beside the old entry page, so the relative paths in its head still find their files.
    let path = `${slug(name, n)}.html`
    for (let k = 2; used.has(path.toLowerCase()) || used.has(path); k++)
      path = `${slug(name, n)}-${k}.html`
    used.add(path)
    used.add(path.toLowerCase())
    files.set(
      path,
      `<!DOCTYPE html>\n<html${attrs(root)}>\n<head>${headInner}</head>\n<body${attrs(body)}>\n${html.slice(page.tag.start, page.end)}\n${shared}\n</body>\n</html>\n`,
    )
    placed.push({
      id: `p${n}`,
      canvas: 'canvas-1',
      section: page.group ? `s${page.group.n}` : null,
      name,
      file: path,
      x: rowX,
      y: rowY,
      width,
      height,
      locked: false,
    })
    rowX += width + PAGE_GAP
    rowHeight = Math.max(rowHeight, height)
    inRow++
  }
  return {
    doc: {
      format: CANVAS_FORMAT,
      canvases: [{ id: 'canvas-1', name: 'Canvas 1' }],
      sections,
      pages: placed,
      notes: [],
    },
    files,
  }
}
