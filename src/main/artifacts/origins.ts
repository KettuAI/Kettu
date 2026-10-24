// The origins artifacts are served on: one per artifact, and only for the artifacts opened in
// this run. See docs/design/artifacts.md#the-protocol.

import { createHash } from 'node:crypto'
import type { WebContents } from 'electron'

export const ARTIFACT_SCHEME = 'overbench-artifact'

const ORIGIN_ID = /^[0-9a-f]{26}$/

/** The host of an artifact's origin: the first 26 hex characters of the SHA-256 of its id. */
export function originId(artifactId: string): string {
  return createHash('sha256').update(artifactId, 'utf8').digest('hex').slice(0, 26)
}

export function artifactUrl(artifactId: string): string {
  return `${ARTIFACT_SCHEME}://${originId(artifactId)}/`
}

/**
 * The origin id of an artifact URL or origin, or null for anything else. Built from the scheme and
 * host, since Node's URL reports a custom scheme's origin as "null".
 */
export function artifactHost(url: string | undefined | null): string | null {
  const parsed = url ? URL.parse(url) : null
  if (!parsed || parsed.protocol !== `${ARTIFACT_SCHEME}:`) return null
  return ORIGIN_ID.test(parsed.host) ? parsed.host : null
}

/**
 * The artifacts main serves, and the origins each window opened for its frames. A window's origin
 * is counted per `open`, since one window can show an artifact in two places.
 */
export class ArtifactOrigins {
  private readonly served = new Map<string, string>()
  private readonly opened = new WeakMap<WebContents, Map<string, number>>()

  /** Serves the artifact for the rest of the run; returns its URL. */
  serve(artifactId: string): string {
    this.served.set(originId(artifactId), artifactId)
    return artifactUrl(artifactId)
  }

  /** Serves the artifact for the rest of the run and lets `contents` frame it; returns its URL. */
  open(contents: WebContents, artifactId: string): string {
    const host = originId(artifactId)
    this.served.set(host, artifactId)
    let counts = this.opened.get(contents)
    if (!counts) {
      counts = new Map()
      this.opened.set(contents, counts)
    }
    counts.set(host, (counts.get(host) ?? 0) + 1)
    return artifactUrl(artifactId)
  }

  /** A page that loads again opens what it shows anew, as the frame guard starts over then. */
  watch(contents: WebContents): void {
    contents.on('did-navigate', () => this.opened.delete(contents))
  }

  /** Undoes one `open` of the artifact at `url` by `contents`; the artifact is still served. */
  close(contents: WebContents, url: string): void {
    const host = artifactHost(url)
    const counts = this.opened.get(contents)
    const count = host ? counts?.get(host) : undefined
    if (!host || !counts || count === undefined) return
    if (count > 1) counts.set(host, count - 1)
    else counts.delete(host)
  }

  /** The artifact served on this origin id, if it was opened in this run. */
  artifactOf(host: string): string | undefined {
    return this.served.get(host)
  }

  /** Whether an artifact URL or origin is one that `contents` opened and has not closed. */
  isOpenedIn(contents: WebContents, url: string): boolean {
    const host = artifactHost(url)
    return host !== null && (this.opened.get(contents)?.has(host) ?? false)
  }
}
