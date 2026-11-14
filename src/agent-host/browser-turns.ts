// Which running turns use which session's page, so the page's agent state lasts the turn rather
// than each call: main, or the desktop app whose page it is, hears when the last turn that used a
// page ended. A subagent's calls use the page of the session it runs under, so a page may be used
// by more than one session's turn at once.

import type { BrowserTarget } from './device-browser'

type PageTarget = Exclude<BrowserTarget, { kind: 'gone' }>

interface PageUse {
  /** The sessions whose running turn called on the page. */
  callers: Set<string>
  /** Where the page is: main's, or a desktop app's port. */
  target: PageTarget
}

export class BrowserTurns {
  private readonly pages = new Map<string, PageUse>()

  /**
   * A call of `caller`'s turn ran on `page`, which is at `target`. When the page's calls moved to
   * another app, the one they left is returned: its page has no turn now.
   */
  used(caller: string, page: string, target: PageTarget): PageTarget | null {
    const use = this.pages.get(page)
    if (!use || !sameTarget(use.target, target)) {
      this.pages.set(page, { callers: new Set([caller]), target })
      return use?.target ?? null
    }
    use.callers.add(caller)
    return null
  }

  /** The turn of `caller` ended: the pages no running turn uses now, and where each one is. */
  turnEnded(caller: string): { page: string; target: PageTarget }[] {
    const ended: { page: string; target: PageTarget }[] = []
    for (const [page, use] of this.pages) {
      if (!use.callers.delete(caller) || use.callers.size > 0) continue
      this.pages.delete(page)
      ended.push({ page, target: use.target })
    }
    return ended
  }

  /** A desktop app's port closed: its pages have no turn to end. */
  portClosed(portId: string): void {
    for (const [page, use] of this.pages) {
      if (use.target.kind === 'device' && use.target.portId === portId) this.pages.delete(page)
    }
  }

  /** Where a page a running turn uses is, or null when none uses it. */
  targetOf(page: string): PageTarget | null {
    return this.pages.get(page)?.target ?? null
  }
}

function sameTarget(a: PageTarget, b: PageTarget): boolean {
  return a.kind === b.kind && (a.kind === 'main' || a.portId === (b as typeof a).portId)
}
