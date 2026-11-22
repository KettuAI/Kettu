// The errors a client keeps of the pages it shows: for each page, those of its latest load, a few
// at most, and how many more came. A page decides what it reports, so the log holds back what
// would flood the client however the page behaves.

import { PAGE_ERRORS, type PageError, type PageErrorMessage } from './page-messages'

/** The errors one page reports each second that the log takes; more are counted, not kept. */
export const PAGE_ERRORS_PER_SECOND = 10
/** The pages the log keeps errors of; the least recent goes first. */
export const PAGES_KEPT = 100

/** One page's errors in its latest load. */
export interface PageErrors {
  /** The served file the page is. */
  path: string
  load: string
  errors: readonly PageError[]
  /** The errors it reported beyond those kept. */
  dropped: number
}

export class PageErrorLog {
  private readonly pages = new Map<string, PageErrors>()
  private readonly second = new Map<string, { at: number; count: number }>()
  /** The loads of each page a later one replaced, whose late reports change nothing. */
  private readonly replaced = new Map<string, string[]>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Takes one report from a page of the artifact on `origin`; false when it changed nothing, as a
   * late report of a load already replaced. One over the limits is counted, not kept.
   */
  add(origin: string, message: PageErrorMessage): boolean {
    const key = `${origin}\0${message.path}`
    if (this.replaced.get(key)?.includes(message.load)) return false
    const was = this.pages.get(key)
    if (was && was.load !== message.load) {
      this.replaced.set(key, [...(this.replaced.get(key) ?? []), was.load].slice(-8))
    }
    const page: PageErrors =
      was && was.load === message.load
        ? was
        : { path: message.path, load: message.load, errors: [], dropped: 0 }
    const at = Math.floor(this.now() / 1000)
    const rate = this.second.get(key)
    const count = rate && rate.at === at ? rate.count + 1 : 1
    this.second.set(key, { at, count })
    const next: PageErrors =
      count > PAGE_ERRORS_PER_SECOND || page.errors.length >= PAGE_ERRORS
        ? { ...page, dropped: page.dropped + 1 }
        : { ...page, errors: [...page.errors, message.error] }
    this.pages.delete(key)
    this.pages.set(key, next)
    while (this.pages.size > PAGES_KEPT) {
      const oldest = this.pages.keys().next().value!
      this.pages.delete(oldest)
      this.second.delete(oldest)
      this.replaced.delete(oldest)
    }
    return true
  }

  /** The errors of the artifact's pages on `origin` that have any, by page. */
  of(origin: string): PageErrors[] {
    const prefix = `${origin}\0`
    return [...this.pages]
      .filter(([key, page]) => key.startsWith(prefix) && page.errors.length + page.dropped > 0)
      .map(([, page]) => page)
  }

  /** Forgets one page's errors, as when it loads again, or every page of the origin. */
  clear(origin: string, path?: string): void {
    for (const key of [...this.pages.keys()]) {
      if (path === undefined ? key.startsWith(`${origin}\0`) : key === `${origin}\0${path}`) {
        this.pages.delete(key)
        this.second.delete(key)
      }
    }
  }
}
