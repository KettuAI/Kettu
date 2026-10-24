// A remark plugin for images that name local files. See docs/design/media.md#spaces-in-a-path.

interface MdNode {
  type: string
  url?: string
  value?: string
  alt?: string | null
  title?: string | null
  children?: MdNode[]
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const DRIVE = /^[a-z]:[\\/]/i
const FILE_URI = /^file:/i
const PREFIX = '/#local-image:'

/**
 * `![alt](path)` that CommonMark leaves as text because the path has a space in it, as agents
 * write paths such as `~/Library/Application Support/...`: an absolute or `./` path, with no
 * parenthesis or line break, that ends in an image's extension and is closed by `)`.
 */
const SPACED_IMAGE =
  /!\[([^\]\n]*)\]\(((?:\/|~[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])[^()\n]*?\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg))\)/gi

function isLocal(url: string): boolean {
  if (url === '' || url.startsWith('#') || url.startsWith('//')) return false
  return !SCHEME.test(url) || DRIVE.test(url) || FILE_URI.test(url)
}

function splitText(value: string): MdNode[] | null {
  const parts: MdNode[] = []
  let last = 0
  for (const match of value.matchAll(SPACED_IMAGE)) {
    if (match.index > last) parts.push({ type: 'text', value: value.slice(last, match.index) })
    parts.push({ type: 'image', url: match[2]!, alt: match[1]!, title: null })
    last = match.index + match[0].length
  }
  if (parts.length === 0) return null
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
  return parts
}

/**
 * Image hardening blocks a local path that does not start with `/` and drops any attribute of our
 * own, so a local image carries its path in the fragment of a root-relative URL, the one form it
 * lets through unchanged. `localImageTarget` reads it back.
 */
export function localImages() {
  const visit = (node: MdNode): void => {
    if (node.type === 'image' && node.url !== undefined && isLocal(node.url)) {
      node.url = PREFIX + encodeURIComponent(node.url)
      return
    }
    if (!node.children) return
    const children: MdNode[] = []
    for (const child of node.children) {
      const split = child.type === 'text' && child.value ? splitText(child.value) : null
      children.push(...(split ?? [child]))
    }
    node.children = children
    children.forEach(visit)
  }
  return visit
}

/** The local path of an image `localImages` rewrote, else null. */
export function localImageTarget(src: string): string | null {
  if (!src.startsWith(PREFIX)) return null
  try {
    return decodeURIComponent(src.slice(PREFIX.length))
  } catch {
    return null
  }
}
