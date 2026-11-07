// A remark plugin for GitHub references written in prose: `owner/repo#12` and `#12`.

import { githubIssueUrl, isRepositoryName } from '@shared/git'

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

// `owner/repo#12` or `#12`, not inside a word, a path or an entity such as `&#12;`.
const REFERENCE =
  /(?<![\w/&#.-])(?:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([\w.-]{1,100}))?#(\d{1,9})(?![\w-])/g
const PREFIX = '#github-ref:'
// Their text is the link's own words, or code, which stays as written.
const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'html', 'definition'])

function split(text: string): MdNode[] | null {
  const out: MdNode[] = []
  let last = 0
  for (const match of text.matchAll(REFERENCE)) {
    const [whole, owner, repo, number] = match
    if (repo && !isRepositoryName(repo)) continue
    const at = match.index
    if (at > last) out.push({ type: 'text', value: text.slice(last, at) })
    // A bare number names an issue in the project's own repository, which only the link knows.
    const url = owner && repo ? githubIssueUrl(owner, repo, Number(number)) : PREFIX + number
    out.push({ type: 'link', url, children: [{ type: 'text', value: whole }] })
    last = at + whole.length
  }
  if (out.length === 0) return null
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) })
  return out
}

/** Turns the references in a reply's text into links, which the link component draws. */
export function githubRefs() {
  const visit = (node: MdNode): void => {
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
