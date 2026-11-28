// A remark plugin for GitHub references written in prose: `owner/repo#12`, `#12` and links to
// pull requests and issues written without `https://`.

import {
  githubIssueUrl,
  githubTextReferences,
  schemelessGitHubLinks,
  schemelessGitHubUrl,
} from '@shared/git'

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

const PREFIX = '#github-ref:'
// Their text is the link's own words, or code, which stays as written.
const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'html', 'definition'])

function split(text: string): MdNode[] | null {
  const found = schemelessGitHubLinks(text)
  for (const ref of githubTextReferences(text)) {
    const { from, to, owner, repo, number } = ref
    if (found.some((link) => from < link.to && to > link.from)) continue
    // A bare number names an issue in the project's own repository, which only the link knows.
    const url = owner && repo ? githubIssueUrl(owner, repo, number) : PREFIX + number
    found.push({ from, to, url })
  }
  if (found.length === 0) return null
  const out: MdNode[] = []
  let last = 0
  for (const { from, to, url } of found.sort((a, b) => a.from - b.from)) {
    if (from > last) out.push({ type: 'text', value: text.slice(last, from) })
    out.push({ type: 'link', url, children: [{ type: 'text', value: text.slice(from, to) }] })
    last = to
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

/**
 * The full address of a link to a pull request or issue written without `https://`: a Markdown
 * link's target, or a `www.` address, which markdown links over `http://`.
 */
function linkTarget(node: MdNode): string | null {
  const url = node.url ?? ''
  const written = url.startsWith('http://') ? url.slice('http://'.length) : url
  const only = node.children?.length === 1 ? node.children[0] : undefined
  if (written !== url && (only?.type !== 'text' || only.value !== written)) return null
  return schemelessGitHubUrl(written)
}

/** Turns the references in a reply's text into links, which the link component draws. */
export function githubRefs() {
  const visit = (node: MdNode): void => {
    if (node.type === 'link') node.url = linkTarget(node) ?? node.url
    if (!node.children || SKIP.has(node.type)) return
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text' && child.value) return split(child.value) ?? [child]
      visit(child)
      return [child]
    })
  }
  return visit
}

/** The number of a bare `#12` reference `githubRefs` linked, else null. */
export function bareReferenceNumber(href: string): number | null {
  if (!href.startsWith(PREFIX)) return null
  const number = Number(href.slice(PREFIX.length))
  return Number.isSafeInteger(number) && number > 0 ? number : null
}
