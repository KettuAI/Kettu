// What a target for sharing does with an artifact's page. Cloudflare is the only one so far; another
// target is another class behind this interface, not another flow.

import type { SharingFailure } from '@shared/sharing'

/** A file of a page to publish, by its path from the page's root, such as `index.html`. */
export interface PageFile {
  path: string
  bytes: Uint8Array
}

/** A published page: where it opens, and what the target knows it by. */
export interface Published {
  url: string
  ref: string
}

export interface SharingProvider {
  /** Puts the page and its files online at a new URL. */
  publish(files: readonly PageFile[], headers: Record<string, string>): Promise<Published>
  /** Replaces the page at the same URL; the one it replaces is no longer reachable. */
  update(ref: string, files: readonly PageFile[], headers: Record<string, string>): Promise<void>
  /** Takes the page down; one the target no longer has counts as done. */
  unpublish(ref: string): Promise<void>
  /** Which of these pages the target still has. */
  existing(refs: readonly string[]): Promise<Set<string>>
}

/** A request to a target that failed, by why, with the target's own words when it gave any. */
export class SharingError extends Error {
  constructor(
    readonly failure: SharingFailure,
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message)
    this.name = 'SharingError'
  }
}
