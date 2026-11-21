// A remark plugin for Codex's citations: of files, `:codex-file-citation{path="..." line_range_start=3}`,
// and of web search sources, `\uE200cite\uE202turn0search1\uE202turn0view0\uE201`.

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

// The directive, with the optional label in brackets that Codex also writes before its attributes.
const CITATION = /:codex-file-citation(?:\[[^\]\n]*\])?\{([^{}\n]*)\}/g
// Codex's app-server never says which source a web citation's id names, so these are left out,
// with the spaces before them; an unclosed one at the end is one still being written.
const WEB_CITATION = /[ \t]*\uE200cite(?:\uE202[^\uE200\uE201\n]*)?(?:\uE201|$)/g
const WEB_CITATION_START = /[ \t]*\uE200(?:c(?:i(?:te?)?)?)?$/
const ATTRIBUTE = /([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))/g
// Their text is the link's own words, or code, which stays as written.
const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'html', 'definition'])

function attributesOf(source: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of source.matchAll(ATTRIBUTE)) {
    out.set(match[1]!, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return out
}

function line(value: string | undefined): number | null {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

/** A link to the cited file, named for it; null when the directive names no path. */
function citation(source: string): MdNode | null {
  const attributes = attributesOf(source)
  const path = attributes.get('path')?.trim()
  if (!path) return null
  const start = line(attributes.get('line_range_start'))
  const end = line(attributes.get('line_range_end'))
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  const lines = start === null ? '' : `:${start}${end !== null && end > start ? `-${end}` : ''}`
  // Only what a link's address cannot hold is escaped, and a Windows drive path keeps its slashes.
  const url = path.replace(/[%\s?#]/g, encodeURIComponent) + (start === null ? '' : `:${start}`)
  return { type: 'link', url, children: [{ type: 'text', value: name + lines }] }
}

function withoutWebCitations(text: string): string {
  return text.replace(WEB_CITATION, '').replace(WEB_CITATION_START, '')
}

function split(source: string): MdNode[] | null {
  const text = withoutWebCitations(source)
  const out: MdNode[] = []
  let last = 0
  for (const match of text.matchAll(CITATION)) {
    const link = citation(match[1]!)
    if (!link) continue
    const at = match.index
    if (at > last) out.push({ type: 'text', value: text.slice(last, at) })
    out.push(link)
    last = at + match[0].length
  }
  if (out.length === 0) return text === source ? null : text ? [{ type: 'text', value: text }] : []
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

/** Turns Codex's file citations in a reply's text into links to the file, and drops its web ones. */
export function codexCitations() {
  const visit = (node: MdNode): void => {
    if (!node.children || SKIP.has(node.type)) return
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text' && child.value) return split(child.value) ?? [child]
      visit(child)
      // A paragraph of citations alone is left empty.
      return child.type === 'paragraph' && child.children?.length === 0 ? [] : [child]
    })
  }
  return visit
}
