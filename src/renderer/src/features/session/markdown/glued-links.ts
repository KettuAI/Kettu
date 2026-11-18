// A remark plugin that splits two addresses written together around a Chinese letter, such as
// `https://a.com/x和https://b.com/y`. Markdown's autolink ends only at a space and Streamdown's CJK
// plugin at Chinese punctuation, since a letter may belong to a path, as in a wiki page's name.

import { linkParts, trimLink } from '../composer/chips'

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

// A Chinese, Japanese or Korean letter right before the scheme of a second address.
const GLUED = /[぀-ヿ㐀-䶿一-鿿가-힯](?=https?:\/\/)/gi
const WEB = /^https?:\/\//i

const text = (value: string): MdNode => ({ type: 'text', value })
const link = (url: string): MdNode => ({ type: 'link', url, children: [text(url)] })

function isBareAddress(node: MdNode): boolean {
  const only = node.children?.[0]
  return (
    node.type === 'link' &&
    node.children?.length === 1 &&
    only?.type === 'text' &&
    only.value === node.url &&
    WEB.test(node.url ?? '')
  )
}

/** The address cut at each letter glued to the next one, as links and the letters; else null. */
function split(address: string): MdNode[] | null {
  const letters = [...address.matchAll(GLUED)]
  if (letters.length === 0) return null
  const parts: MdNode[] = []
  let from = 0
  for (const letter of letters) {
    const url = trimLink(address.slice(from, letter.index))
    parts.push(linkParts(url) ? link(url) : text(url))
    // What the trim took off, such as a full stop, and the letter itself stay text.
    parts.push(text(address.slice(from + url.length, letter.index + 1)))
    from = letter.index + 1
  }
  // The last address ends where the whole one did, which markdown already trimmed.
  const last = address.slice(from)
  parts.push(linkParts(last) ? link(last) : text(last))
  return parts
}

/** Splits the addresses of a reply that Chinese letters join into one link. */
export function gluedLinks() {
  const visit = (node: MdNode): void => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return
    node.children = node.children.flatMap((child) => {
      const parts = isBareAddress(child) ? split(child.url!) : null
      if (parts) return parts
      visit(child)
      return [child]
    })
  }
  return visit
}
