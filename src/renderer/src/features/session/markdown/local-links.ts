// A remark plugin for links to local paths.

interface MdNode {
  type: string
  url?: string
  children?: MdNode[]
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const DRIVE = /^[a-z]:[\\/]/i
const PREFIX = '#local:'

/** Whether a link's URL is a local path, which `localLinks` marks. */
export function isLocalLink(url: string): boolean {
  if (url === '' || url.startsWith('#') || url.startsWith('//')) return false
  return !SCHEME.test(url) || DRIVE.test(url)
}

/**
 * Link hardening blocks a link to a relative path, rewrites `./x` as `/x`, and sanitizing drops
 * any attribute of our own, so a link to a local path carries its target in a fragment, the one
 * form both let through. `localTarget` reads it back.
 */
export function localLinks() {
  const visit = (node: MdNode): void => {
    const url = node.url ?? ''
    if (node.type === 'link' && isLocalLink(url)) {
      node.url = PREFIX + encodeURIComponent(url)
    }
    node.children?.forEach(visit)
  }
  return visit
}

/** The local path of a link `localLinks` rewrote, else null. */
export function localTarget(href: string): string | null {
  if (!href.startsWith(PREFIX)) return null
  try {
    return decodeURIComponent(href.slice(PREFIX.length))
  } catch {
    return null
  }
}
