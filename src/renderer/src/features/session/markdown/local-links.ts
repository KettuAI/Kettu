// A remark plugin for links to local paths, and to addresses Kettu does not open.

import { schemelessGitHubUrl } from '@shared/git'
import { bareHostUrl } from './bare-host-links'

interface MdNode {
  type: string
  url?: string
  children?: MdNode[]
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i
const DRIVE = /^[a-z]:[\\/]/i
const FILE_URI = /^file:/i
const WEB = /^https?:/i
const PREFIX = '#local:'
const UNOPENED = '#unopened:'
// Streamdown's href for a link still streaming in, which its sanitizing keeps.
export const INCOMPLETE_LINK = 'streamdown:incomplete-link'

/**
 * Whether a link's URL is a local path or a `file:` URI, which `localLinks` marks. A GitHub pull
 * request or issue written without `https://`, or a bare host:port address, is the web link its
 * remark plugin makes of it.
 */
export function isLocalLink(url: string): boolean {
  if (url === '' || url.startsWith('#') || url.startsWith('//')) return false
  if (schemelessGitHubUrl(url)) return false
  if (bareHostUrl(url)) return false
  return !SCHEME.test(url) || DRIVE.test(url) || FILE_URI.test(url)
}

/**
 * Link hardening blocks a link to a relative path or a `file:` URI, rewrites `./x` as `/x`, and
 * sanitizing drops any attribute of our own, so a link to a local path carries its target in a
 * fragment, the one form both let through. `localTarget` reads it back. So does a link to an
 * address of another scheme, such as `vscode:`, which sanitizing would empty and hardening then
 * mark as blocked; `unopenedTarget` reads it back.
 */
export function localLinks() {
  const visit = (node: MdNode): void => {
    const url = node.url ?? ''
    if (node.type === 'link' && isLocalLink(url)) {
      node.url = PREFIX + encodeURIComponent(url)
    } else if (node.type === 'link' && SCHEME.test(url) && !WEB.test(url)) {
      if (url !== INCOMPLETE_LINK) node.url = UNOPENED + encodeURIComponent(url)
    }
    node.children?.forEach(visit)
  }
  return visit
}

function fragmentTarget(href: string, prefix: string): string | null {
  if (!href.startsWith(prefix)) return null
  try {
    return decodeURIComponent(href.slice(prefix.length))
  } catch {
    return null
  }
}

/** The local path of a link `localLinks` rewrote, else null. */
export function localTarget(href: string): string | null {
  return fragmentTarget(href, PREFIX)
}

/** The address of another scheme of a link `localLinks` rewrote, else null. */
export function unopenedTarget(href: string): string | null {
  return fragmentTarget(href, UNOPENED)
}
